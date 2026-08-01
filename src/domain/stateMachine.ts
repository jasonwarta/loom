/**
 * Task and Run state machines (ARCHITECTURE section 8). Transitions are
 * validated: an illegal transition throws rather than silently corrupting
 * state. This is the guard the store's setters rely on being called behind.
 */

import type { RunState, TaskState } from "./model.js";

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ["queued", "cancelled", "escalated"],
  queued: ["dispatched", "cancelled", "escalated"],
  dispatched: ["running", "failed", "cancelled"],
  running: ["waiting", "review", "failed", "cancelled"],
  // waiting -> queued: an operator resume re-queues the task as a fresh run
  // (no live backend run exists to rejoin after the worker reported blocked).
  waiting: ["running", "queued", "escalated", "cancelled"],
  review: ["completed", "revision_requested", "failed", "cancelled"],
  revision_requested: ["queued", "cancelled"],
  retry: ["queued", "cancelled"],
  failed: ["retry", "escalated", "cancelled"],
  escalated: ["queued", "cancelled"],
  completed: [],
  cancelled: [],
};

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  dispatching: ["running", "errored", "cancelled"],
  running: ["waiting", "completed", "errored", "cancelled", "timed_out"],
  waiting: ["running", "completed", "errored", "cancelled", "timed_out"],
  completed: [],
  errored: [],
  cancelled: [],
  timed_out: [],
};

export class IllegalTransitionError extends Error {
  constructor(kind: "task" | "run", from: string, to: string) {
    super(`illegal ${kind} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) throw new IllegalTransitionError("task", from, to);
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError("run", from, to);
}
