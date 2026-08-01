/**
 * The Backend Contract -- the single provider boundary of the platform.
 *
 * Everything above this interface (scheduler, queue, dispatcher, review
 * pipeline, operator) speaks ONLY these methods and the normalized types in
 * ./types. Adding or swapping a provider is a new implementation of this
 * interface plus a registry entry -- nothing above the boundary changes. That
 * is the prime directive (docs/ARCHITECTURE.md sections 9, 26).
 */

import type {
  BackendCapabilities,
  BackendErrorCode,
  BackendHealth,
  ReviewResult,
  ReviewSpec,
  RunHandle,
  RunId,
  RunResult,
  RunSpec,
  RunStatus,
} from "./types.js";

/** The normalized error every adapter throws. Providers' native errors are translated into this. */
export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(code: BackendErrorCode, message: string, opts?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    // transient/timeout are retryable by default; everything else is not.
    this.retryable = opts?.retryable ?? (code === "transient" || code === "timeout");
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

export interface Backend {
  readonly id: string;

  /** Static, honest declaration of what this backend can do. */
  capabilities(): BackendCapabilities;

  /**
   * Start a run. MUST tag the backend run with spec.runId so it is findable
   * after a crash (see findRun). Returns a handle carrying native ids.
   * Throws BackendError on failure.
   */
  dispatch(spec: RunSpec): Promise<RunHandle>;

  /** Cheap, idempotent status snapshot. */
  poll(handle: RunHandle): Promise<RunStatus>;

  /** Final structured result. Callers should only call once a poll shows a terminal phase. */
  result(handle: RunHandle): Promise<RunResult>;

  /** Graceful cancel if supported, forceful otherwise. Idempotent: cancelling a finished run is a no-op. */
  cancel(handle: RunHandle): Promise<void>;

  /** Continue a run. Cross-restart recoverability depends on capabilities().crossRestartRecoverable. */
  resume(handle: RunHandle, addendum?: string): Promise<RunHandle>;

  /**
   * Recover a handle for a run that may have been started before a crash, by
   * the platform-generated runId. Returns null if this backend has no such run.
   * This is the durability obligation that makes dispatch effectively idempotent
   * (docs/ARCHITECTURE.md section 15).
   */
  findRun(runId: RunId): Promise<RunHandle | null>;

  /** Optional native review. If absent (or capabilities().supportsNativeReview false), the platform uses a review worker. */
  review?(spec: ReviewSpec): Promise<ReviewResult>;

  /** Is this backend usable right now? Drives registry availability transitions. */
  healthcheck(): Promise<BackendHealth>;
}
