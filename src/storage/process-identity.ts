import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIdentity } from "../domain/model.js";

const execFileAsync = promisify(execFile);

export async function inspectProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!isProcessReachable(pid)) return null;
  const startMarker = process.platform === "linux"
    ? await linuxStartMarker(pid)
    : await portableStartMarker(pid);
  return startMarker === null ? null : Object.freeze({ pid, startMarker });
}

export async function processIdentityMatches(identity: ProcessIdentity): Promise<boolean> {
  const current = await inspectProcessIdentity(identity.pid);
  return current !== null && current.startMarker === identity.startMarker;
}

function isProcessReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function linuxStartMarker(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    return startTime === undefined ? null : `linux:${startTime}`;
  } catch {
    return null;
  }
}

async function portableStartMarker(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const marker = stdout.trim();
    return marker.length === 0 ? null : `ps:${marker}`;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
