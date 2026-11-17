// TM1 facade. Domain-specific OData calls live in service classes
// (`this.cubes`, etc.) — see docs/ARCHITECTURE.md. Connection lifecycle
// (authenticate / keep-alive / logout) lives here; everything else is
// delegated to the relevant service.
import type pino from "pino";
import { connectionIdOf, type TM1Config } from "./config.js";
import type { SessionManager } from "./session-manager.js";
import { TM1HttpClient } from "./tm1-client/http.js";
import { BatchService } from "./tm1-client/services/batch-service.js";
import { CubeService } from "./tm1-client/services/cube-service.js";
import { DimensionService } from "./tm1-client/services/dimension-service.js";
import { HierarchyService } from "./tm1-client/services/hierarchy-service.js";
import { ElementService } from "./tm1-client/services/element-service.js";
import { CellService } from "./tm1-client/services/cell-service.js";
import { DimensionOrderCache } from "./tm1-client/services/dimension-order.js";
import { ViewService } from "./tm1-client/services/view-service.js";
import { SubsetService } from "./tm1-client/services/subset-service.js";
import { ProcessService } from "./tm1-client/services/process-service.js";
import { ChoreService } from "./tm1-client/services/chore-service.js";
import { SecurityService } from "./tm1-client/services/security-service.js";
import { ServerService } from "./tm1-client/services/server-service.js";
import { FileService } from "./tm1-client/services/file-service.js";
import { RestService } from "./tm1-client/services/rest-service.js";
import { SandboxService } from "./tm1-client/services/sandbox-service.js";
import { registerCallgraphCacheInvalidation } from "./lib/callgraph/tm1-adapter.js";

export class TM1Client {
  // Transport is HELD, not inherited. TM1Client does not extend TM1HttpClient,
  // so its public type does not expose `request()/requestRaw()/
  // requestBinary()`, so a tool typed on TM1Client cannot call raw REST — that
  // is a compile error (`tsc`).
  // Services that legitimately need transport receive `this.http` explicitly.
  private readonly http: TM1HttpClient;
  private readonly sessionManager: SessionManager;
  private readonly logger: pino.Logger;
  private readonly config: TM1Config;

  // Domain services. Init order matters when services depend on each other —
  // `cells` is created before `elements` because the latter holds a CellService
  // ref for the element-attribute-value methods that route through MDX/cellset.
  readonly batch: BatchService;
  readonly cubes: CubeService;
  readonly dimensions: DimensionService;
  readonly hierarchies: HierarchyService;
  readonly cells: CellService;
  readonly views: ViewService;
  readonly subsets: SubsetService;
  readonly elements: ElementService;
  readonly processes: ProcessService;
  readonly chores: ChoreService;
  readonly security: SecurityService;
  readonly server: ServerService;
  readonly files: FileService;
  readonly sandboxes: SandboxService;
  // Guarded generic passthrough for tm1_rest_read / tm1_rest_write only.
  readonly rest: RestService;

  constructor(
    config: TM1Config,
    sessionManager: SessionManager,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.http = new TM1HttpClient(config, sessionManager, logger);
    this.sessionManager = sessionManager;
    this.logger = logger;
    // Wire the callgraph cache-invalidation listener to tm1Events "mutation"
    // notifications. An explicit, idempotent call at construction.
    registerCallgraphCacheInvalidation();
    this.batch = new BatchService(this.http);
    // One dimension-order cache per connection, shared by cubes and cells.
    const dimOrder = new DimensionOrderCache(this.http);
    this.cubes = new CubeService(this.http, dimOrder);
    this.dimensions = new DimensionService(this.http);
    this.hierarchies = new HierarchyService(this.http);
    this.cells = new CellService(this.http, dimOrder);
    this.views = new ViewService(this.http);
    this.subsets = new SubsetService(this.http);
    // ElementService depends on CellService and BatchService — both MUST be
    // constructed above. Enforced at runtime so a future reorder fails loudly
    // instead of injecting `undefined` (TS types the fields as defined, so the
    // compiler won't catch a move). `batch` is asserted too even though the
    // constructor parameter is optional: an undefined batch degrades bulkUpsert
    // silently back to N round-trips, with no error and no failing test.
    if (!this.cells) {
      throw new Error(
        "TM1Client init order: CellService must be constructed before ElementService",
      );
    }
    if (!this.batch) {
      throw new Error(
        "TM1Client init order: BatchService must be constructed before ElementService",
      );
    }
    this.elements = new ElementService(this.http, this.cells, this.batch);
    this.processes = new ProcessService(this.http);
    this.chores = new ChoreService(this.http);
    this.security = new SecurityService(this.http);
    this.server = new ServerService(this.http);
    this.files = new FileService(this.http);
    this.rest = new RestService(this.http);
    this.sandboxes = new SandboxService(this.http);
    // Re-read after every login, first or re-auth. See SessionManager.onLogin.
    sessionManager.onLogin = () => this.readSandboxing();
  }

  /** The configured TM1 major version (11 or 12). Fixed for this connection. */
  get version(): 11 | 12 {
    return this.config.version;
  }

  /** TM1_MODE. Tools that write consult it through ./lib/sandbox-policy.ts. */
  get mode(): TM1Config["mode"] {
    return this.config.mode;
  }

  /** TM1_SANDBOX_PREFIX: the sandboxes this server manages in sandbox mode. */
  get sandboxPrefix(): string {
    return this.config.sandboxPrefix;
  }

  /**
   * Stable label for this connection, used to keep per-connection files (the
   * process backups) apart: host and port, plus the v12 instance/database.
   */
  get connectionId(): string {
    return connectionIdOf(this.config);
  }

  /** TM1 rejected the credentials (401/403); see SessionManager. */
  get loginRejected(): boolean {
    return this.sessionManager.isLoginRejected();
  }

  /** A TM1 session is currently open. */
  get sessionActive(): boolean {
    return this.sessionManager.isSessionActive();
  }

  /**
   * Whether TM1 has DisableSandboxing=T, as read after the last login.
   * `undefined` until a login has been read, and when the setting cannot be
   * read (TM1 12 has no such field).
   */
  sandboxingDisabled: boolean | undefined;

  /** Read DisableSandboxing after a login. Never throws; unknown stays undefined. */
  private async readSandboxing(): Promise<void> {
    this.sandboxingDisabled = await this.server.isSandboxingDisabled();
  }

  /**
   * Start the keep-alive timer and authenticate.
   */
  async connect(): Promise<void> {
    this.logger.info("Connecting to TM1 server");
    // Timer first: when this login fails, a later tool call logs in through
    // ensureSession() and nothing else would start the keep-alive. A rejected
    // login (401/403) stops the timer again inside authenticate().
    this.sessionManager.startKeepAlive();
    await this.sessionManager.authenticate();
    this.logger.info("Connected to TM1 server");
  }

  /**
   * Stop the keep-alive timer and end the session.
   */
  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting from TM1 server");
    this.sessionManager.stopKeepAlive();
    await this.sessionManager.logout();
    this.logger.info("Disconnected from TM1 server");
  }

  /** True while a TM1 session is held, however it was obtained. */
  isConnected(): boolean {
    return this.sessionManager.isSessionActive();
  }
}
