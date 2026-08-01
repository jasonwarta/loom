/**
 * Normalized platform types -- the lingua franca every backend speaks.
 *
 * NOTHING in these types is provider-specific. A backend adapter translates
 * between these and its provider's native shapes; the scheduler, queue,
 * dispatcher, and operator only ever see what is defined here. If a field here
 * would only make sense for one provider, it is in the wrong file.
 *
 * See docs/ARCHITECTURE.md section 9.
 */

/** Platform-generated run identifier. Assigned before dispatch (transactional-outbox intent). */
export type RunId = string;
/** Durable task identifier. */
export type TaskId = string;
/** Registry worker identifier. */
export type WorkerId = string;

/** Reasoning/effort level requested of a worker. Mirrors the common provider range. */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** How a run is isolated from concurrent runs. */
export type IsolationMode = "worktree" | "sandbox" | "none";

/**
 * The workspace a run executes in. A discriminated union keyed by mode so the
 * "normalized" claim actually covers every declared IsolationMode -- not just
 * worktrees (ARCHITECTURE section 9, hardening finding C1).
 */
export type IsolationUnit =
  | { readonly mode: "worktree"; readonly path: string; readonly branch: string }
  | { readonly mode: "sandbox"; readonly sandboxRef: string }
  | { readonly mode: "none" };

/** Least-privilege policy the platform imposes on a run (ARCHITECTURE section 22). */
export interface IsolationPolicy {
  /** Filesystem write scope: read-only, the run's workspace only, or unrestricted (discouraged). */
  readonly writeScope: "read-only" | "workspace" | "full";
  /** Network egress policy. "none" = no outbound; "restricted" = allowlist; "full" = unrestricted. */
  readonly networkEgress: "none" | "restricted" | "full";
}

/** Wall-clock and cost bounds the platform enforces (backends have no native timeout/cost cap). */
export interface RunConstraints {
  readonly wallClockMs?: number;
  /** Hard cost ceiling in NORMALIZED USD. The adapter is responsible for producing USD estimates. */
  readonly costCeilingUsd?: number;
}

/** Normalized resource usage. Providers meter differently; adapters convert to these units. */
export interface Usage {
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
}

/** Everything needed to start a run, fully provider-agnostic. */
export interface RunSpec {
  /** Platform-generated run id. The adapter MUST tag the backend run with this so it is findable after a crash. */
  readonly runId: RunId;
  readonly taskId: TaskId;
  /** Open, governed tag set (ARCHITECTURE section 12). Not a closed enum. */
  readonly taskType: string;
  readonly effort: Effort;
  /** A hint. The adapter resolves it to a concrete provider model; the scheduler may ignore it. */
  readonly modelPreference?: string;
  /** Reference to the pre-built context package (see ContextBuilder). Not the content itself. */
  readonly contextPackageRef: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly isolationUnit: IsolationUnit;
  readonly isolationPolicy: IsolationPolicy;
  readonly constraints: RunConstraints;
  readonly expectedDeliverables: readonly string[];
  /** Optional JSON schema constraining the structured deliverable. */
  readonly outputSchema?: unknown;
  /** On a revision run, the prior review's findings, for the worker to address. */
  readonly priorReviewFindings?: string;
  /**
   * True when this run resumes prior work already present in its workspace
   * (recovery mode): the workspace is checked out on an existing branch, not a
   * fresh one off the base. A normalized, durable marker of a resumed run; the
   * worker-facing "prior work exists, continue it" guidance is injected into the
   * context package (see ContextBuilder), not read from this flag by backends.
   */
  readonly resumedWork?: boolean;
}

/**
 * A durable, opaque-to-callers reference to a started run. Persisted so any
 * process (after a restart) can operate the run. `native` carries whatever the
 * adapter needs to poll/cancel/resume (e.g. Codex threadId+turnId).
 */
export interface RunHandle {
  readonly runId: RunId;
  readonly backendId: string;
  /** Adapter-owned native identifiers. Opaque above the adapter boundary. */
  readonly native: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

export type RunPhase =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "errored"
  | "cancelled"
  | "timed_out";

/** A normalized progress event streamed from a backend that supports it. */
export interface ProgressEvent {
  readonly at: number;
  readonly kind: string;
  readonly message?: string;
}

/** Why a run is paused awaiting input (supports the Waiting task state / mid-run clarification). */
export interface WaitingInfo {
  readonly reason: string;
  readonly question?: string;
}

/** Cheap, idempotent status snapshot returned by poll(). */
export interface RunStatus {
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly progress?: readonly ProgressEvent[];
  readonly startedAt?: number;
  readonly lastHeartbeat?: number;
  /** Live partial usage for in-run cost enforcement; null/absent for black-box backends. */
  readonly usageSoFar?: Usage;
  /** Present when phase === "waiting". */
  readonly waiting?: WaitingInfo;
}

export type RunResultStatus = "completed" | "errored" | "cancelled" | "timed_out" | "blocked";

/** Normalized error attached to a non-successful result. */
export interface RunError {
  readonly code: BackendErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** The structured output of a run. */
export interface RunResult {
  readonly runId: RunId;
  readonly status: RunResultStatus;
  readonly finalMessage?: string;
  readonly touchedFiles?: readonly string[];
  readonly branchRef?: string;
  readonly diffRef?: string;
  readonly commandLog?: readonly string[];
  /** Schema-validated deliverables when outputSchema was requested. */
  readonly deliverables?: Readonly<Record<string, unknown>>;
  readonly usage?: Usage;
  readonly error?: RunError;
  /** Present when status === "blocked" (needs input beyond the worker). */
  readonly blocked?: WaitingInfo;
}

export type ReviewTarget =
  | { readonly type: "uncommitted" }
  | { readonly type: "baseBranch"; readonly branch: string };

export interface ReviewSpec {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly target: ReviewTarget;
  readonly acceptanceCriteria: readonly string[];
  readonly diffRef?: string;
}

export type ReviewVerdict = "accept" | "revise" | "reject";

export interface ReviewFinding {
  readonly severity: "S0" | "S1" | "S2";
  readonly title: string;
  readonly detail?: string;
  readonly location?: string;
}

export interface ReviewResult {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewFinding[];
}

export type BackendAvailability = "available" | "degraded" | "offline" | "rate_limited";

export interface BackendHealth {
  readonly status: BackendAvailability;
  readonly detail?: string;
}

/**
 * Static, honestly-declared capabilities. The platform degrades by capability,
 * never by special-casing a provider name (ARCHITECTURE section 9).
 */
export interface BackendCapabilities {
  readonly supportsResume: boolean;
  readonly supportsGracefulCancel: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsNativeReview: boolean;
  readonly streamsProgress: boolean;
  readonly isolationModes: readonly IsolationMode[];
  readonly maxConcurrentRuns: number | null;
  /** Can the adapter produce normalized USD cost estimates? If false, cost weight is zeroed. */
  readonly reportsCost: boolean;
  /**
   * Does a started run survive a daemon/host restart and remain resumable
   * (e.g. Codex on-disk sessions)? If false, in-flight runs are re-queued as
   * fresh runs on restart, not resumed (finding C2).
   */
  readonly crossRestartRecoverable: boolean;
}

/** Normalized backend error codes. Adapters translate provider errors into these. */
export type BackendErrorCode =
  | "dispatch_failed"
  | "not_found"
  | "transient"
  | "timeout"
  | "cancelled"
  | "invalid_spec"
  | "unsupported";
