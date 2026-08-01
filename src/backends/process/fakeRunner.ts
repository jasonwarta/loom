/**
 * FakeProcessRunner -- replays a scripted process so CLI adapters can be unit-
 * and conformance-tested without spawning anything (free, deterministic).
 *
 * A script maps a ProcSpec to a plan: the stdout lines to emit, and how it
 * ends -- a normal exit code, or `hang: true` to stay "running" (stdout open)
 * until kill() is called (models a long run we cancel).
 */

import type { ProcExit, ProcHandle, ProcSpec, ProcessRunner } from "./runner.js";

export interface FakePlan {
  readonly lines?: readonly string[];
  readonly exitCode?: number;
  /** Scripted stderr, delivered with the exit (models a CLI that dies with a message). */
  readonly stderr?: string;
  /**
   * Terminate with a POSIX signal instead of a normal exit (models an OOM
   * SIGKILL or a segfault). A signal-death exits with code=null; the adapter
   * should surface the signal in its error so the crash is diagnosable.
   */
  readonly signal?: NodeJS.Signals;
  /** Stay running until killed (stdout does not close on its own). */
  readonly hang?: boolean;
  /** Run a side effect at start (e.g. write an -o output file the adapter will read). */
  readonly sideEffect?: (spec: ProcSpec) => void;
  /** Make start() throw, modelling a synchronous spawn failure (adapter should surface dispatch_failed). */
  readonly throwOnStart?: boolean;
  /**
   * Model an ASYNCHRONOUS spawn failure (e.g. ENOENT: binary not on PATH),
   * which the real runner reports via the child's 'error' event -> ProcExit
   * .spawnError, NOT a synchronous throw. The adapter should surface a
   * non-retryable dispatch_failed result.
   */
  readonly spawnError?: string;
}

export type FakeScript = (spec: ProcSpec) => FakePlan;

export class FakeProcessRunner implements ProcessRunner {
  constructor(private readonly script: FakeScript) {}

  start(spec: ProcSpec): ProcHandle {
    const plan = this.script(spec);
    if (plan.throwOnStart) throw new Error("fake: scripted spawn failure");
    plan.sideEffect?.(spec);

    const lines = plan.lines ?? [];
    const hang = plan.hang ?? false;
    let killed = false;
    let killSignal: NodeJS.Signals | null = null;

    let resolveExit!: (e: ProcExit) => void;
    const exitP = new Promise<ProcExit>((res) => {
      resolveExit = res;
    });
    let resolveKilled!: () => void;
    const killedP = new Promise<void>((res) => {
      resolveKilled = res;
    });

    async function* gen(): AsyncIterable<string> {
      if (plan.spawnError !== undefined) {
        // Failed to spawn: no stdout, the exit carries the spawn error.
        resolveExit({ code: null, signal: null, stderr: "", spawnError: plan.spawnError });
        return;
      }
      for (const l of lines) {
        if (killed) return;
        yield l;
        await Promise.resolve(); // give the event loop a turn so poll() can interleave
      }
      if (hang) {
        await killedP; // stay open until killed
        return;
      }
      // A signal-death carries no exit code (code=null); a clean exit defaults to 0.
      const code = plan.signal ? (plan.exitCode ?? null) : (plan.exitCode ?? 0);
      resolveExit({ code, signal: plan.signal ?? null, stderr: plan.stderr ?? "" });
    }

    return {
      pid: 424242,
      lines: gen,
      kill: (signal?: NodeJS.Signals) => {
        if (killed) return;
        killed = true;
        killSignal = signal ?? "SIGTERM";
        resolveKilled();
        resolveExit({ code: null, signal: killSignal, stderr: "" });
      },
      wait: () => exitP,
    };
  }
}
