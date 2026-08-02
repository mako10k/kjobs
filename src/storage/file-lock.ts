import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./atomic-file.js";
import { inspectProcessIdentity, processIdentityMatches } from "./process-identity.js";
import type { ProjectLock, ProjectLockLease } from "./ports.js";

interface LockRecord {
  readonly schema_version: 1;
  readonly invocation_id: string;
  readonly pid: number;
  readonly process_start_marker: string;
  readonly acquired_at: string;
}

export class LockConflictError extends Error {
  constructor(readonly owner: LockRecord | null) {
    super("project lock is held by a live process");
    this.name = "LockConflictError";
  }
}

export class FileProjectLock implements ProjectLock {
  constructor(private readonly path: string) {}

  async acquire(invocationId: string): Promise<ProjectLockLease> {
    await ensurePrivateDirectory(dirname(this.path));
    const identity = await inspectProcessIdentity(process.pid);
    if (identity === null) throw new Error("unable to identify the current process");
    const record: LockRecord = {
      schema_version: 1,
      invocation_id: invocationId,
      pid: identity.pid,
      process_start_marker: identity.startMarker,
      acquired_at: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const handle = await open(this.path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new FileProjectLockLease(this.path, invocationId);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const owner = await readLockRecord(this.path);
        if (owner !== null && await processIdentityMatches({ pid: owner.pid, startMarker: owner.process_start_marker })) {
          throw new LockConflictError(owner);
        }
        if (owner === null && !await unknownLockIsStale(this.path)) throw new LockConflictError(null);
        try {
          await unlink(this.path);
        } catch (unlinkError) {
          if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new LockConflictError(await readLockRecord(this.path));
  }
}

async function unknownLockIsStale(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Date.now() - metadata.mtimeMs >= 2_000;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

class FileProjectLockLease implements ProjectLockLease {
  private released = false;

  constructor(
    private readonly path: string,
    readonly invocationId: string,
  ) {}

  async release(): Promise<void> {
    if (this.released) return;
    const current = await readLockRecord(this.path);
    if (current !== null && current.invocation_id === this.invocationId) {
      try {
        await unlink(this.path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    this.released = true;
  }
}

async function readLockRecord(path: string): Promise<LockRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)
      || value.schema_version !== 1
      || typeof value.invocation_id !== "string"
      || !Number.isInteger(value.pid)
      || typeof value.process_start_marker !== "string"
      || typeof value.acquired_at !== "string") return null;
    return value as unknown as LockRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
