/**
 * AbstractCliBackend -- shared machinery for backends that drive a CLI which
 * runs a task to completion while streaming JSONL events (Codex `exec`, Claude
 * `-p --output-format stream-json`).
 *
 * The lifecycle mapping:
 *  - dispatch(): spawn the CLI, return immediately with a handle, and consume
 *    the event stream in the background (capturing session id + progress, and
 *    the final result on exit).
 *  - poll(): report the in-memory phase (running until the child exits).
 *  - result(): the parsed result once terminal.
 *  - cancel(): kill the child (these CLIs have no cancel-by-id in exec mode).
 *  - resume(): spawn the CLI's resume form within the daemon's lifetime.
 *
 * findRun() returns null after a restart: an exec-mode child does not survive
 * the daemon, and neither CLI lets us tag its session with our runId. So both
 * declare crossRestartRecoverable=false and the platform re-queues in-flight
 * runs on restart (which reconciliation already handles). A future app-server
 * / resume-by-session path can raise this; the contract already admits it.
 */

import { existsSync, statSync } from "node:fs";
import { BackendError, type Backend } from "../contract/backend.js";
import type {
  BackendCapabilities,
  BackendHealth,
  ProgressEvent,
  RunHandle,
  RunId,
  RunPhase,
  RunResult,
  RunSpec,
  RunStatus,
} from "../contract/types.js";
import type { ProcessRunner, ProcSpec } from "./process/runner.js";

export interface CliEntry {
  readonly runId: RunId;
  readonly spec: RunSpec;
  handle: import("./process/runner.js").ProcHandle;
  phase: RunPhase;
  progress: ProgressEvent[];
  sessionId: string | undefined;
  finalMessage: string | undefined;
  touchedFiles: string[];
  result: RunResult | undefined;
  done: boolean;
  killed: boolean;
  /** Resolves when the background consumer finishes (the run is terminal). */
  donePromise: Promise<void>;
  resolveDone: () => void;
  /** Subclass scratch space for accumulating parsed state. */
  readonly data: Record<string, unknown>;
}

export abstract class AbstractCliBackend implements Backend {
  abstract readonly id: string;
  protected abstract readonly cmd: string;
  protected readonly runner: ProcessRunner;
  private readonly runs = new Map<RunId, CliEntry>();
  now: () => number = () => Date.now();

  constructor(runner: ProcessRunner) {
    this.runner = runner;
  }

  abstract capabilities(): BackendCapabilities;
  /** Build the CLI arguments for a fresh run. */
  protected abstract buildArgs(spec: RunSpec): string[];
  /** Build the CLI arguments to resume a run (throw if unsupported). */
  protected abstract resumeArgs(entry: CliEntry, addendum?: string): string[];
  /** Handle one parsed JSONL event: capture sessionId, progress, final message. */
  protected abstract onEvent(entry: CliEntry, event: Record<string, unknown>): void;
  /**
   * Called for EVERY non-empty stdout line, before JSON parsing. Default no-op.
   * Override for plain-text CLIs (e.g. `agy --print`) that don't emit JSONL, to
   * capture raw output. This is what lets the one contract span JSONL-streaming
   * and plain-text backends alike.
   */
  protected onRawLine(_entry: CliEntry, _line: string): void {}
  /** Build the final result from accumulated state + exit code (non-cancelled path). */
  protected abstract finalize(entry: CliEntry, exitCode: number | null): RunResult;

  /** Tail of the child's captured stderr, for diagnosable error messages. */
  protected stderrTail(entry: CliEntry, maxChars = 2000): string {
    const raw = typeof entry.data["stderr"] === "string" ? (entry.data["stderr"] as string).trim() : "";
    if (raw.length === 0) return "";
    return raw.length > maxChars ? `...${raw.slice(-maxChars)}` : raw;
  }

  /**
   * The POSIX signal that terminated the child, if any. A process killed by a
   * signal exits with code=null; without the signal the error reads "exited
   * null", hiding the single most useful fact -- notably SIGKILL, the shape of
   * an OOM kill. finalize() appends this so a kill is diagnosable.
   */
  protected killSignal(entry: CliEntry): string | null {
    return typeof entry.data["signal"] === "string" ? (entry.data["signal"] as string) : null;
  }

  async dispatch(spec: RunSpec): Promise<RunHandle> {
    const procSpec: ProcSpec = {
      cmd: this.cmd,
      args: this.buildArgs(spec),
      ...cwdFor(spec),
    };
    let handle;
    try {
      handle = this.runner.start(procSpec);
    } catch (err) {
      throw new BackendError("dispatch_failed", `${this.id}: failed to start ${this.cmd}`, { cause: err });
    }
    const entry: CliEntry = {
      runId: spec.runId,
      spec,
      handle,
      phase: "starting",
      progress: [],
      sessionId: undefined,
      finalMessage: undefined,
      touchedFiles: [],
      result: undefined,
      done: false,
      killed: false,
      donePromise: Promise.resolve(),
      resolveDone: () => {},
      data: {},
    };
    this.runs.set(spec.runId, entry);
    this.launch(entry);
    return { runId: spec.runId, backendId: this.id, native: {}, createdAt: this.now() };
  }

  /** (Re)start the background consumer for an entry, arming its done-promise. */
  private launch(entry: CliEntry): void {
    entry.done = false;
    entry.killed = false;
    entry.result = undefined;
    entry.phase = "running";
    entry.donePromise = new Promise<void>((resolve) => {
      entry.resolveDone = resolve;
    });
    void this.consume(entry);
  }

  private async consume(entry: CliEntry): Promise<void> {
    entry.phase = "running";
    try {
      for await (const line of entry.handle.lines()) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.onRawLine(entry, trimmed);
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // non-JSON log line; ignore (plain-text backends use onRawLine)
        }
        if (parsed && typeof parsed === "object") {
          this.onEvent(entry, parsed as Record<string, unknown>);
        }
      }
      const exit = await entry.handle.wait();
      // Keep stderr/signal for finalize(): a CLI that dies on startup says WHY
      // only there, and an errored result without it is undiagnosable. The
      // signal is what distinguishes an OOM/SIGKILL from a clean non-zero exit.
      entry.data["stderr"] = exit.stderr;
      if (exit.signal) entry.data["signal"] = exit.signal;
      if (exit.spawnError !== undefined) entry.data["spawnError"] = exit.spawnError;
      if (entry.killed) {
        entry.result = { runId: entry.runId, status: "cancelled" };
        entry.phase = "cancelled";
      } else if (typeof entry.data["spawnError"] === "string") {
        // The binary never started (e.g. not on PATH). A run-time retry cannot
        // fix a missing/misconfigured CLI, so this is non-retryable -- the
        // orchestrator escalates it immediately instead of burning attempts.
        entry.result = {
          runId: entry.runId,
          status: "errored",
          error: {
            code: "dispatch_failed",
            message: `${this.id}: failed to start ${this.cmd}: ${entry.data["spawnError"] as string}`,
            retryable: false,
          },
        };
        entry.phase = "errored";
      } else {
        entry.result = this.finalize(entry, exit.code);
        entry.phase = phaseFromStatus(entry.result.status);
      }
    } catch (err) {
      entry.result = {
        runId: entry.runId,
        status: "errored",
        error: { code: "transient", message: String(err), retryable: true },
      };
      entry.phase = "errored";
    }
    entry.done = true;
    entry.resolveDone();
  }

  async poll(handle: RunHandle): Promise<RunStatus> {
    const entry = this.runs.get(handle.runId);
    if (!entry) throw new BackendError("not_found", `${this.id}: no run ${handle.runId}`);
    return {
      runId: entry.runId,
      phase: entry.phase,
      progress: entry.progress,
      lastHeartbeat: this.now(),
    };
  }

  async result(handle: RunHandle): Promise<RunResult> {
    const entry = this.runs.get(handle.runId);
    if (!entry) throw new BackendError("not_found", `${this.id}: no run ${handle.runId}`);
    if (!entry.result) {
      return {
        runId: entry.runId,
        status: "errored",
        error: { code: "transient", message: "result requested before run terminal", retryable: true },
      };
    }
    return entry.result;
  }

  async cancel(handle: RunHandle): Promise<void> {
    const entry = this.runs.get(handle.runId);
    if (!entry || entry.done) return;
    entry.killed = true;
    entry.handle.kill();
    // Wait until the consumer has observed the kill and set the terminal state,
    // so a poll immediately after cancel() reflects "cancelled".
    await entry.donePromise;
  }

  async resume(handle: RunHandle, addendum?: string): Promise<RunHandle> {
    const entry = this.runs.get(handle.runId);
    if (!entry) throw new BackendError("not_found", `${this.id}: cannot resume unknown run ${handle.runId}`);
    if (!this.capabilities().supportsResume) throw new BackendError("unsupported", `${this.id}: resume unsupported`);
    const args = this.resumeArgs(entry, addendum);
    const procSpec: ProcSpec = {
      cmd: this.cmd,
      args,
      ...cwdFor(entry.spec),
    };
    entry.handle = this.runner.start(procSpec);
    this.launch(entry);
    return { runId: entry.runId, backendId: this.id, native: {}, createdAt: this.now() };
  }

  async findRun(runId: RunId): Promise<RunHandle | null> {
    // Returns what THIS instance knows. After a daemon restart the map is empty
    // (exec-mode children do not survive, and neither CLI lets us tag its
    // session with our runId), so this returns null and reconciliation
    // re-queues -- consistent with crossRestartRecoverable=false.
    const entry = this.runs.get(runId);
    if (!entry) return null;
    return {
      runId,
      backendId: this.id,
      native: entry.sessionId ? { sessionId: entry.sessionId } : {},
      createdAt: this.now(),
    };
  }

  async healthcheck(): Promise<BackendHealth> {
    return { status: "available" };
  }
}

/**
 * Resolve the child's working directory: the isolation worktree when there is
 * one; otherwise the spec's repo path when it is a real directory (so e.g. a
 * dispatched review run with no worktree still executes inside the repo it is
 * reviewing, not in whatever directory the daemon happened to start from).
 */
function cwdFor(spec: RunSpec): { cwd?: string } {
  if (spec.isolationUnit.mode === "worktree") return { cwd: spec.isolationUnit.path };
  if (existsSync(spec.repo) && statSync(spec.repo).isDirectory()) return { cwd: spec.repo };
  return {};
}

function phaseFromStatus(status: RunResult["status"]): RunPhase {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "blocked":
      return "waiting";
    case "errored":
      return "errored";
  }
}
