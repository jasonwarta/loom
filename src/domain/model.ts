/**
 * Domain model: the durable entities and their state spaces.
 * Task and Run are distinct (ARCHITECTURE section 8): a Task has many Runs.
 */

import type { RunResult, RunSpec, TaskId, RunId, WorkerId, Effort } from "../contract/index.js";

/** Task lifecycle states (ARCHITECTURE section 8). */
export type TaskState =
  | "created"
  | "queued"
  | "dispatched"
  | "running"
  | "waiting"
  | "review"
  | "revision_requested"
  | "retry"
  | "completed"
  | "failed"
  | "cancelled"
  | "escalated";

/** Run sub-lifecycle. `dispatching` is the transactional-outbox intent before a handle exists. */
export type RunState =
  | "dispatching"
  | "running"
  | "waiting"
  | "completed"
  | "errored"
  | "cancelled"
  | "timed_out";

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "cancelled",
]);

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "completed",
  "errored",
  "cancelled",
  "timed_out",
]);

/** What the operator submits: enough to schedule the task and later build a RunSpec. */
export interface TaskDefinition {
  readonly taskType: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: number;
  readonly effort: Effort;
  readonly repo: string;
  readonly baseBranch: string;
  /** Tasks that must be Completed before this one is dispatch-eligible. */
  readonly deps: readonly TaskId[];
  /** If true, review must use a worker other than the implementer. */
  readonly requiresIndependentReview: boolean;
  /** Optional wall-clock budget (ms) for each run of this task. */
  readonly wallClockMs?: number;
  /** Optional file paths to include in the context package (relative to the repo). */
  readonly contextFiles?: readonly string[];
  /**
   * Optional executable check that objectively verifies the task is done (e.g. a
   * test command). The strongest form of acceptance criteria; makes review
   * objective. Required by the readiness gate under a strict policy.
   */
  readonly verificationCommand?: string;
  /**
   * Recovery mode: an EXISTING branch holding prior, possibly-unpushed work for
   * this task. When set, the run's workspace is checked out on this branch
   * instead of branching fresh from `baseBranch`, and the worker is told prior
   * work exists and to continue it rather than restart. Used to resume work an
   * earlier run produced but never delivered (e.g. after a crash or a failed
   * commit/push), and to build on in-flight branches instead of colliding.
   */
  readonly resumeFromBranch?: string;
}

export interface TaskRecord {
  readonly id: TaskId;
  readonly definition: TaskDefinition;
  readonly state: TaskState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RunRecord {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly backendId: string;
  readonly runSpec: RunSpec;
  /** Null while `dispatching` (handle not yet captured). Set when the run reaches `running`. */
  readonly nativeHandle: Readonly<Record<string, string>> | null;
  readonly state: RunState;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly createdAt: number;
}

/** An append-only audit + recovery event. */
export interface TaskEvent {
  readonly seq: number;
  readonly taskId: TaskId;
  readonly at: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type StoredRunResult = RunResult & { readonly storedAt: number };
