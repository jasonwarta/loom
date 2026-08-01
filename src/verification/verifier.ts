/**
 * Verification: execute a task's `verificationCommand` platform-side, in the
 * run's committed worktree, BEFORE review. This is what makes "executable
 * acceptance criteria" real: workers cannot be trusted to have run the check
 * (some backends cannot execute commands at all), and an LLM review is not a
 * substitute for the test suite actually passing.
 *
 * A verification failure short-circuits review into the bounded revision loop
 * (with the command output as findings); a pass is recorded and surfaced to the
 * reviewer so the review can focus on semantics, not mechanics.
 */

import { execFile } from "node:child_process";

export interface VerificationOutcome {
  readonly ok: boolean;
  readonly exitCode: number | null;
  /** Combined stdout+stderr, tail-truncated (the end is where the failure is). */
  readonly output: string;
}

export interface Verifier {
  run(command: string, cwd: string): Promise<VerificationOutcome>;
}

export interface ShellVerifierOptions {
  /** Wall-clock budget for the command. Default 10 minutes. */
  readonly timeoutMs?: number;
  /** Max characters of combined output to keep (tail). Default 8000. */
  readonly maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT = 8000;

/** Runs the command through `sh -c` in the given cwd. Never throws; failures are outcomes. */
export class ShellVerifier implements Verifier {
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(opts: ShellVerifierOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  }

  run(command: string, cwd: string): Promise<VerificationOutcome> {
    return new Promise((resolvePromise) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        { cwd, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const combined = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
          const output =
            combined.length > this.maxOutputChars ? `...(truncated)\n${combined.slice(-this.maxOutputChars)}` : combined;
          if (!err) {
            resolvePromise({ ok: true, exitCode: 0, output });
            return;
          }
          // err.code is the exit code for non-zero exits; killed=true on timeout.
          const killed = (err as { killed?: boolean }).killed === true;
          const rawCode = (err as { code?: number | string }).code;
          const exitCode = typeof rawCode === "number" ? rawCode : null;
          resolvePromise({
            ok: false,
            exitCode,
            output: killed ? `${output}\n(verification timed out after ${this.timeoutMs}ms)` : output,
          });
        },
      );
    });
  }
}
