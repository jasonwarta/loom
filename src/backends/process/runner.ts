/**
 * ProcessRunner -- the seam between a CLI-backed adapter and the OS.
 *
 * Adapters (Codex, Claude) spawn a CLI, stream its stdout as JSONL lines, wait
 * for exit, and kill to cancel. They depend on THIS interface, not on
 * node:child_process directly, so the same adapter code runs against a fake
 * runner in tests (free, deterministic) and the real CLI in production.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ProcSpec {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

export interface ProcExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  /**
   * Set when the child failed to *spawn* (e.g. the CLI binary is not on PATH,
   * emitted asynchronously as an 'error' event, NOT a synchronous throw). This
   * is a configuration fault, not a run-time crash -- retrying it cannot help,
   * so the backend classifies it non-retryable.
   */
  readonly spawnError?: string;
}

export interface ProcHandle {
  readonly pid: number | undefined;
  /** stdout, one line at a time, until the process closes stdout. */
  lines(): AsyncIterable<string>;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<ProcExit>;
}

export interface ProcessRunner {
  start(spec: ProcSpec): ProcHandle;
}

export class RealProcessRunner implements ProcessRunner {
  start(spec: ProcSpec): ProcHandle {
    const child = spawn(spec.cmd, [...spec.args], {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // ALWAYS close stdin. If left open, some CLIs (e.g. `codex exec`) finish the
    // task and then block "Reading additional input from stdin...", so the
    // process never exits and stdout never EOFs -- the run would appear to hang
    // forever. Closing stdin (after any input) lets the CLI terminate cleanly.
    if (child.stdin) {
      if (spec.input !== undefined) child.stdin.write(spec.input);
      child.stdin.end();
    }

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const exit = new Promise<ProcExit>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal, stderr }));
      child.on("error", (err) => resolve({ code: null, signal: null, stderr, spawnError: String(err) }));
    });

    const stdout = child.stdout;
    async function* lineGen(): AsyncIterable<string> {
      if (!stdout) return;
      const rl = createInterface({ input: stdout, crlfDelay: Infinity });
      for await (const line of rl) yield line;
    }

    return {
      pid: child.pid,
      lines: lineGen,
      kill: (signal?: NodeJS.Signals) => {
        child.kill(signal ?? "SIGTERM");
      },
      wait: () => exit,
    };
  }
}
