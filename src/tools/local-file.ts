import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { TM1Error, TM1ErrorCode } from "../types.js";

const ROOT_ENV = "TM1_LOCAL_FILE_ROOT";

/**
 * Resolve symlinks as deeply as the filesystem allows: realpath the nearest
 * EXISTING ancestor (the target itself may not exist yet — write paths are
 * confined before the file is created), then re-append the not-yet-existing
 * tail lexically. Walks up one component at a time until realpathSync stops
 * throwing; at worst it terminates at the filesystem root.
 */
function realpathNearestExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      // A link whose target does not exist yet is not a missing file: a write
      // follows it and creates the target, wherever that is.
      if (isSymlink(current)) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Path goes through a symbolic link that cannot be resolved: ${current}`,
        });
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Nothing on the path exists (not even "/", practically unreachable);
        // fall back to the lexical path so the caller's check still runs.
        return path.join(current, ...tail);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    // Missing, or below a regular file (ENOTDIR): no link either way.
    return false;
  }
}

/**
 * Split `TM1_LOCAL_FILE_ROOT` into its roots. `;` separates them on every
 * platform: `:` is part of a Windows drive letter, so path.delimiter would not
 * read the same everywhere. Blank entries (trailing or doubled `;`) are ignored.
 */
function parseRoots(value: string | undefined): string[] {
  return (value ?? "")
    .split(";")
    .map((r) => r.trim())
    .filter((r) => r !== "")
    .map((r) => path.resolve(r));
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !(
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  );
}

/**
 * Resolve a caller-supplied host filesystem path, confined to the directories
 * configured via `TM1_LOCAL_FILE_ROOT` when any are set.
 *
 * Without a root, stdio (the default transport) allows any absolute path: the
 * server runs as the same user as its client, so there is nothing to protect.
 * Over HTTP the callers are remote, so host-file access stays DISABLED until a
 * root is set — otherwise anyone reaching the endpoint could read the host's
 * files (TM1 credentials, `~/.ssh`) or write anywhere.
 *
 * When roots ARE configured, on either transport, the resolved absolute path
 * must lie inside any one of them; any `..` traversal, absolute escape or
 * escaping symlink is rejected. The variable may name several roots separated
 * by `;`. Returns the resolved absolute path.
 */
export function resolveLocalPath(
  inputPath: string,
  paramName = "filePath",
): string {
  const roots = parseRoots(process.env[ROOT_ENV]);
  if (
    roots.length === 0 &&
    process.env.TM1_MCP_TRANSPORT?.trim().toLowerCase() === "http"
  ) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message:
        `Host-file access is disabled over HTTP. Set ${ROOT_ENV} to an allowed directory in the server ` +
        `environment (MCP 'env:' block or a user environment variable, not a connection .env), ` +
        `then restart the server to enable '${paramName}'. Or pass the content inline.`,
    });
  }
  if (!path.isAbsolute(inputPath)) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${paramName} must be absolute: ${inputPath}`,
    });
  }
  if (roots.length === 0) return path.resolve(inputPath);
  const resolved = path.resolve(inputPath);
  const allowed = roots.join("; ");
  if (!roots.some((root) => isWithin(root, resolved))) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `${paramName} escapes the allowed ${ROOT_ENV} directory (${allowed}): ${inputPath}`,
    });
  }
  // Symlink-safe second check: the lexical check above is bypassable by a
  // symlink placed INSIDE a root that points outside it. Compare real paths
  // instead — and realpath every root too, since a root itself may
  // legitimately be a symlink (e.g. /tmp on some systems).
  const realResolved = realpathNearestExisting(resolved);
  if (
    !roots.some((root) => isWithin(realpathNearestExisting(root), realResolved))
  ) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message:
        `${paramName} escapes the allowed ${ROOT_ENV} directory (${allowed}) ` +
        `after resolving symlinks: ${inputPath}`,
    });
  }
  return resolved;
}
