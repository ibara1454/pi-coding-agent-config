import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { delimiter, join } from "node:path";

interface ProcessOptions {
  cwd: string;
  env?: Record<string, string>;
}

function signalProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        throw error;
      }
    }
  }
  child.kill(signal);
}

/**
 * Starts a piped child with the project's local binaries on PATH.
 * The caller owns its lifetime; on POSIX, launcher exit also kills its process group.
 */
export function spawnProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv & { PATH?: string } = {
    ...process.env,
    ...options.env,
  };
  env.PATH = `${join(options.cwd, "node_modules", ".bin")}${delimiter}${env.PATH ?? ""}`;
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A crashed launcher must not leave its server descendants running.
  child.once("exit", () => {
    if (process.platform === "win32" || !child.pid) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group normally disappears with its last member.
    }
  });
  return child;
}

/**
 * Terminates an owned process, escalating from SIGTERM to SIGKILL after one second.
 * Owners must coalesce concurrent calls; failure to observe exit rejects the promise.
 */
export async function stopProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let forceTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      child.off("close", onClose);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    child.once("close", onClose);
    try {
      signalProcess(child, "SIGTERM");
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    forceTimer = setTimeout(() => {
      try {
        signalProcess(child, "SIGKILL");
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      deadlineTimer = setTimeout(() => {
        cleanup();
        reject(new Error("Language-server process did not exit after SIGKILL"));
      }, 2_000);
    }, 1_000);
  });
}

/**
 * Runs a finite command, closes stdin, and captures at most 512 KiB per stream by default.
 * Cancellation, timeout, and overflow stop it once and reject; truncated output is never returned.
 * Nonzero exit codes are returned for the caller to interpret.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: ProcessOptions & {
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  options.signal?.throwIfAborted();
  const limit = options.maxOutputBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 16 * 1024 * 1024) {
    throw new Error("Command output limit must be between 1 byte and 16 MiB");
  }
  const child = spawnProcess(command, args, options);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let failure: unknown;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const result = Promise.withResolvers<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>();
  const onStdout = (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > limit) {
      stop(
        new Error(
          `Command stdout exceeded ${limit} bytes; output is incomplete`,
        ),
      );
    } else {
      stdout.push(chunk);
    }
  };
  const onStderr = (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes > limit) {
      stop(
        new Error(
          `Command stderr exceeded ${limit} bytes; output is incomplete`,
        ),
      );
    } else {
      stderr.push(chunk);
    }
  };
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
    child.off("error", onError);
    child.off("close", onClose);
    child.stdin.off("error", onInputError);
  };
  const onError = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    result.reject(error);
  };
  const stop = (reason: unknown) => {
    if (settled || failure !== undefined) {
      return;
    }
    failure = reason;
    stopProcess(child).catch(onError);
  };
  const onAbort = () => {
    stop(options.signal?.reason ?? new Error("Command cancelled"));
  };
  const onInputError = (error: NodeJS.ErrnoException) => {
    // A process may exit before consuming stdin; its exit status is authoritative.
    if (error.code !== "EPIPE") {
      stop(error);
    }
  };
  const onClose = (code: number | null) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (failure !== undefined) {
      result.reject(failure);
      return;
    }
    result.resolve({
      stdout: Buffer.concat(stdout, outBytes).toString("utf8"),
      stderr: Buffer.concat(stderr, errBytes).toString("utf8"),
      exitCode: code ?? 1,
    });
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.once("error", onError);
  child.once("close", onClose);
  child.stdin.on("error", onInputError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(
    () => stop(new Error(`Command timed out: ${command}`)),
    Math.max(1, options.timeoutMs ?? 30_000),
  );
  if (options.signal?.aborted) {
    onAbort();
  }
  child.stdin.end(options.input ?? "");
  return await result.promise;
}
