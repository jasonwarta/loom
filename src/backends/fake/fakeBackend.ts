/**
 * FakeBackend -- a scriptable, provider-free implementation of the Backend
 * contract. It exists to (a) prove the contract is implementable and pleasant
 * to write against before any real provider is wired, and (b) let the
 * scheduler/queue/dispatcher/persistence be tested at zero cost and full
 * determinism (docs/ARCHITECTURE.md section 23, IMPLEMENTATION-PLAN M0).
 *
 * Optionally journal-backed: with a journalPath, started runs are recorded to a
 * JSON file so findRun/poll/result survive a process restart -- modelling a
 * cross-restart-recoverable backend (Codex on-disk sessions). Without one, run
 * state is in-memory only -- modelling a non-durable backend (in-process
 * subagents). This lets one fake exercise both durability stories.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { BackendError, type Backend } from "../../contract/backend.js";
import type {
  BackendCapabilities,
  BackendHealth,
  ReviewResult,
  ReviewSpec,
  RunHandle,
  RunId,
  RunPhase,
  RunResult,
  RunSpec,
  RunStatus,
} from "../../contract/types.js";

/** How a single scripted run should behave. Everything is optional; sane defaults apply. */
export interface FakeOutcome {
  /** If "fail", dispatch throws a BackendError (dispatch_failed). */
  readonly dispatch?: "ok" | "fail";
  /** Phase sequence returned by successive poll() calls. The last entry must be terminal. */
  readonly phases?: readonly RunPhase[];
  /** The result returned by result() once terminal. Defaults to a trivial completed result. */
  readonly result?: Partial<Omit<RunResult, "runId">>;
  /** Per-poll normalized cost, accumulated into usageSoFar. */
  readonly costPerPollUsd?: number;
}

/** Decides the outcome for a run from its spec. Default: completes after starting -> running -> completed. */
export type FakeScript = (spec: RunSpec) => FakeOutcome;

interface FakeRecord {
  runId: RunId;
  native: Record<string, string>;
  phases: RunPhase[];
  result: RunResult;
  costPerPollUsd: number;
  pollCount: number;
  cancelled: boolean;
  createdAt: number;
}

const TERMINAL: ReadonlySet<RunPhase> = new Set(["completed", "errored", "cancelled", "timed_out"]);

const defaultScript: FakeScript = () => ({});

/** Scripts a native review verdict from the review spec. Default: accept. */
export type FakeReviewScript = (spec: ReviewSpec) => ReviewResult;

export interface FakeBackendOptions {
  readonly id?: string;
  readonly journalPath?: string;
  readonly script?: FakeScript;
  readonly reviewScript?: FakeReviewScript;
  readonly capabilities?: Partial<BackendCapabilities>;
  readonly health?: BackendHealth;
}

const BASE_CAPS: BackendCapabilities = {
  supportsResume: true,
  supportsGracefulCancel: true,
  supportsStructuredOutput: true,
  supportsNativeReview: true,
  streamsProgress: true,
  isolationModes: ["worktree", "none"],
  maxConcurrentRuns: null,
  reportsCost: true,
  crossRestartRecoverable: false, // overridden to true when journal-backed
};

const defaultReviewScript: FakeReviewScript = () => ({ verdict: "accept", findings: [] });

export class FakeBackend implements Backend {
  readonly id: string;
  private readonly journalPath?: string;
  private readonly script: FakeScript;
  private readonly reviewScript: FakeReviewScript;
  private readonly caps: BackendCapabilities;
  private readonly health: BackendHealth;
  private readonly mem = new Map<RunId, FakeRecord>();
  /** clock is injectable for deterministic tests; defaults to Date.now. */
  now: () => number = () => Date.now();

  constructor(opts: FakeBackendOptions = {}) {
    this.id = opts.id ?? "fake";
    if (opts.journalPath !== undefined) this.journalPath = opts.journalPath;
    this.script = opts.script ?? defaultScript;
    this.reviewScript = opts.reviewScript ?? defaultReviewScript;
    this.health = opts.health ?? { status: "available" };
    this.caps = {
      ...BASE_CAPS,
      crossRestartRecoverable: this.journalPath !== undefined,
      ...opts.capabilities,
    };
  }

  capabilities(): BackendCapabilities {
    return this.caps;
  }

  async dispatch(spec: RunSpec): Promise<RunHandle> {
    const outcome = this.script(spec);
    if (outcome.dispatch === "fail") {
      throw new BackendError("dispatch_failed", `fake: scripted dispatch failure for ${spec.runId}`);
    }
    const phases = [...(outcome.phases ?? (["starting", "running", "completed"] as RunPhase[]))];
    if (phases.length === 0 || !TERMINAL.has(phases[phases.length - 1]!)) {
      throw new BackendError("invalid_spec", "fake: outcome.phases must end in a terminal phase");
    }
    const terminal = phases[phases.length - 1]!;
    const native = { fakeRunId: spec.runId, session: `sess-${spec.runId}` };
    const result: RunResult = {
      runId: spec.runId,
      status: terminalToResultStatus(terminal),
      finalMessage: outcome.result?.finalMessage ?? `fake completed ${spec.runId}`,
      ...(outcome.result?.touchedFiles ? { touchedFiles: outcome.result.touchedFiles } : {}),
      ...(outcome.result?.branchRef ? { branchRef: outcome.result.branchRef } : {}),
      ...(outcome.result?.deliverables ? { deliverables: outcome.result.deliverables } : {}),
      ...(outcome.result?.error ? { error: outcome.result.error } : {}),
      ...(outcome.result?.blocked ? { blocked: outcome.result.blocked } : {}),
    };
    const rec: FakeRecord = {
      runId: spec.runId,
      native,
      phases,
      result,
      costPerPollUsd: outcome.costPerPollUsd ?? 0,
      pollCount: 0,
      cancelled: false,
      createdAt: this.now(),
    };
    this.put(rec);
    return { runId: spec.runId, backendId: this.id, native, createdAt: rec.createdAt };
  }

  async poll(handle: RunHandle): Promise<RunStatus> {
    const rec = this.get(handle.runId);
    if (!rec) throw new BackendError("not_found", `fake: no run ${handle.runId}`);
    if (rec.cancelled) return { runId: rec.runId, phase: "cancelled", startedAt: rec.createdAt };
    const idx = Math.min(rec.pollCount, rec.phases.length - 1);
    const phase = rec.phases[idx]!;
    rec.pollCount += 1;
    this.put(rec);
    const usageSoFar =
      this.caps.reportsCost && rec.costPerPollUsd > 0
        ? { costUsd: rec.costPerPollUsd * rec.pollCount }
        : undefined;
    return {
      runId: rec.runId,
      phase,
      startedAt: rec.createdAt,
      lastHeartbeat: this.now(),
      ...(usageSoFar ? { usageSoFar } : {}),
    };
  }

  async result(handle: RunHandle): Promise<RunResult> {
    const rec = this.get(handle.runId);
    if (!rec) throw new BackendError("not_found", `fake: no run ${handle.runId}`);
    if (rec.cancelled) return { runId: rec.runId, status: "cancelled" };
    return rec.result;
  }

  async cancel(handle: RunHandle): Promise<void> {
    const rec = this.get(handle.runId);
    if (!rec) return; // idempotent
    rec.cancelled = true;
    this.put(rec);
  }

  async resume(handle: RunHandle, _addendum?: string): Promise<RunHandle> {
    const rec = this.get(handle.runId);
    if (!rec) throw new BackendError("not_found", `fake: cannot resume unknown run ${handle.runId}`);
    rec.cancelled = false;
    // Re-arm: let it progress from the start of its phase sequence again.
    rec.pollCount = 0;
    this.put(rec);
    return { runId: rec.runId, backendId: this.id, native: rec.native, createdAt: rec.createdAt };
  }

  async findRun(runId: RunId): Promise<RunHandle | null> {
    const rec = this.get(runId);
    if (!rec) return null;
    return { runId: rec.runId, backendId: this.id, native: rec.native, createdAt: rec.createdAt };
  }

  async review(spec: ReviewSpec): Promise<ReviewResult> {
    return this.reviewScript(spec);
  }

  async healthcheck(): Promise<BackendHealth> {
    return this.health;
  }

  // --- record storage: memory or JSON-file journal ---

  private get(runId: RunId): FakeRecord | undefined {
    if (this.journalPath) return this.readJournal()[runId];
    return this.mem.get(runId);
  }

  private put(rec: FakeRecord): void {
    if (this.journalPath) {
      const all = this.readJournal();
      all[rec.runId] = rec;
      writeFileSync(this.journalPath, JSON.stringify(all), "utf8");
      return;
    }
    this.mem.set(rec.runId, rec);
  }

  private readJournal(): Record<RunId, FakeRecord> {
    if (!this.journalPath || !existsSync(this.journalPath)) return {};
    return JSON.parse(readFileSync(this.journalPath, "utf8")) as Record<RunId, FakeRecord>;
  }
}

function terminalToResultStatus(phase: RunPhase): RunResult["status"] {
  switch (phase) {
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    default:
      return "errored";
  }
}
