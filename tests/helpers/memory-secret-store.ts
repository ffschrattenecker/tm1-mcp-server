import type { SecretKey, SecretStore } from "../../src/secrets.js";

/** In-memory stand-in for the OS keychain. */
export class MemorySecretStore implements SecretStore {
  readonly entries = new Map<string, string>();
  reads = 0;

  get(connection: string, key: SecretKey): string | undefined {
    this.reads++;
    return this.entries.get(`${connection}/${key}`);
  }

  set(connection: string, key: SecretKey, value: string): void {
    this.entries.set(`${connection}/${key}`, value);
  }

  delete(connection: string, key: SecretKey): boolean {
    return this.entries.delete(`${connection}/${key}`);
  }
}
