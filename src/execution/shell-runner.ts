import { createWriteStream, type WriteStream } from "node:fs";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ProcessIdentity, TerminalReason } from "../domain/model.js";
import { inspectProcessIdentity, processIdentityMatches } from "../storage/process-identity.js";

export interface ShellStartRequest {
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly stdoutTee?: Writable;
  readonly stderrTee?: Writable;
  readonly signal?: AbortSignal;
}

export interface ShellCompletion {
  readonly reason: TerminalReason;
  readonly finishedAt: string;
}

export interface ShellHandle {
  readonly identity: ProcessIdentity;
  readonly startedAt: string;
  readonly completion: Promise<ShellCompletion>;
  cancel(): void;
}

export async function startShell(request: ShellStartRequest): Promise<ShellHandle> {
  const stdout = createWriteStream(request.stdoutPath, { flags: "a", mode: 0o600 });
  const stderr = createWriteStream(request.stderrPath, { flags: "a", mode: 0o600 });
  const child = spawn(request.shell, ["-c", request.command], {
    cwd: request.cwd,
    env: { ...request.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  if (request.stdoutTee !== undefined) child.stdout.on("data", (chunk: Buffer) => request.stdoutTee!.write(chunk));
  if (request.stderrTee !== undefined) child.stderr.on("data", (chunk: Buffer) => request.stderrTee!.write(chunk));

  const spawned = waitForSpawn(child);
  const completionState = createCompletion(child, stdout, stderr);
  try {
    await spawned;
  } catch (error) {
    stdout.end();
    stderr.end();
    await Promise.allSettled([finished(stdout), finished(stderr)]);
    throw error;
  }

  const pid = child.pid;
  if (pid === undefined) throw new Error("spawned child has no pid");
  const startedAt = new Date().toISOString();
  const inspectedIdentity = await identifyStartedProcess(pid);
  const identity: ProcessIdentity | null = inspectedIdentity ?? (
    child.exitCode !== null || child.signalCode !== null
      ? Object.freeze({ pid, startMarker: `exited:${startedAt}` })
      : null
  );
  if (identity === null) {
    signalProcessGroup(pid, "SIGTERM");
    throw new Error("unable to identify spawned process");
  }
  const grace = request.terminationGraceMs ?? 1_000;
  let requestedReason: "timeout" | "canceled" | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const terminate = (reason: "timeout" | "canceled"): void => {
    if (requestedReason !== null) return;
    requestedReason = reason;
    signalProcessGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      void processIdentityMatches(identity).then((matches) => {
        if (matches) signalProcessGroup(pid, "SIGKILL");
      });
    }, grace);
    killTimer.unref();
  };

  const timeout = request.timeoutMs === undefined
    ? null
    : setTimeout(() => terminate("timeout"), request.timeoutMs);
  timeout?.unref();
  const abort = (): void => terminate("canceled");
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted === true) abort();

  const completion = completionState.then(async (result): Promise<ShellCompletion> => {
    if (timeout !== null) clearTimeout(timeout);
    if (killTimer !== null) clearTimeout(killTimer);
    request.signal?.removeEventListener("abort", abort);
    const reason: TerminalReason = requestedReason === "timeout"
      ? { kind: "timeout" }
      : requestedReason === "canceled"
        ? { kind: "canceled" }
        : result;
    return Object.freeze({ reason, finishedAt: new Date().toISOString() });
  });

  return Object.freeze({ identity, startedAt, completion, cancel: abort });
}

type ShellChild = ChildProcessByStdio<null, Readable, Readable>;

function waitForSpawn(child: ShellChild): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function createCompletion(
  child: ShellChild,
  stdout: WriteStream,
  stderr: WriteStream,
): Promise<TerminalReason> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (reason: TerminalReason): void => {
      if (settled) return;
      settled = true;
      Promise.allSettled([finished(stdout), finished(stderr)]).then(() => resolve(reason));
    };
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      settle({ kind: "spawn_error", ...(typeof code === "string" ? { code } : {}) });
    });
    child.once("close", (code, signal) => {
      if (code !== null) settle({ kind: "exit", code });
      else if (signal !== null) settle({ kind: "signal", signal });
      else settle({ kind: "spawn_error" });
    });
  });
}

async function identifyStartedProcess(pid: number): Promise<ProcessIdentity | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const identity = await inspectProcessIdentity(pid);
    if (identity !== null) return identity;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return null;
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
