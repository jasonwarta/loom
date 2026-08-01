/**
 * Dispatcher: turns a scheduling decision into a running, then completed, Run.
 *
 * Owns the run-level lifecycle only (intent -> dispatch -> handle -> poll ->
 * result). Task-level state transitions and review are the control plane's job.
 * The transactional-outbox ordering (ARCHITECTURE section 15) lives here:
 * recordRunIntent BEFORE backend.dispatch, attachRunHandle AFTER.
 */

import type { Backend } from "../contract/backend.js";
import type { IsolationUnit, RunResult, RunSpec, RunHandle } from "../contract/types.js";
import { BackendError } from "../contract/backend.js";
import type { LoomStore } from "../persistence/store.js";
import type { TaskRecord } from "../domain/model.js";
import type { WorkerRecord } from "../scheduler/registry.js";

export interface DispatchOptions {
  /** Max poll iterations before giving up (safety net; real timeout is wall-clock below). */
  readonly maxPolls?: number;
  /** Delay between polls in ms (0 for tests). */
  readonly pollDelayMs?: number;
  /** Wall-clock budget in ms; on breach the run is cancelled and recorded timed_out. */
  readonly wallClockMs?: number;
  /** Injectable clock for deterministic timeout tests. */
  readonly now?: () => number;
}

/** Per-run extras the control plane threads into the spec (notes, resume marker). */
export interface RunExtras {
  /**
   * Pre-labeled markdown appended to the worker's prompt (e.g. "## Prior review
   * findings to address\n..." and/or "## Operator note\n..."). Backends append
   * it verbatim -- the control plane owns the section headers.
   */
  readonly priorNotes?: string;
  /** True when this run resumes an existing branch (recovery OR revision). */
  readonly resumedWork?: boolean;
}

/** Build a provider-agnostic RunSpec from a task + chosen worker. */
export function buildRunSpec(
  task: TaskRecord,
  worker: WorkerRecord,
  runId: string,
  isolationUnit: IsolationUnit = { mode: "none" },
  contextPackageRef?: string,
  extras?: RunExtras,
): RunSpec {
  const resumedWork = extras?.resumedWork ?? task.definition.resumeFromBranch !== undefined;
  return {
    runId,
    taskId: task.id,
    taskType: task.definition.taskType,
    effort: task.definition.effort,
    modelPreference: worker.model,
    contextPackageRef: contextPackageRef ?? `task:${task.id}`,
    repo: task.definition.repo,
    baseBranch: task.definition.baseBranch,
    isolationUnit,
    isolationPolicy: { writeScope: "workspace", networkEgress: "none" },
    constraints: task.definition.wallClockMs !== undefined ? { wallClockMs: task.definition.wallClockMs } : {},
    expectedDeliverables: ["branch"],
    ...(extras?.priorNotes !== undefined ? { priorReviewFindings: extras.priorNotes } : {}),
    ...(resumedWork ? { resumedWork: true } : {}),
  };
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Start a run using the transactional-outbox pattern. Returns the handle.
 * On dispatch failure, marks the run errored and rethrows (caller decides retry).
 */
export async function startRun(
  store: LoomStore,
  backend: Backend,
  task: TaskRecord,
  worker: WorkerRecord,
  runId: string,
  isolationUnit: IsolationUnit = { mode: "none" },
  contextPackageRef?: string,
  extras?: RunExtras,
): Promise<{ runId: string; handle: RunHandle; spec: RunSpec }> {
  const spec = buildRunSpec(task, worker, runId, isolationUnit, contextPackageRef, extras);

  // WRITE-AHEAD intent: the run is durable BEFORE the external side effect.
  store.recordRunIntent({
    runId,
    taskId: task.id,
    workerId: worker.workerId,
    backendId: backend.id,
    runSpec: spec,
  });

  let handle: RunHandle;
  try {
    handle = await backend.dispatch(spec);
  } catch (err) {
    store.setRunState(runId, "errored");
    throw err instanceof BackendError ? err : new BackendError("dispatch_failed", String(err), { cause: err });
  }
  // Backfill the captured native handle AFTER dispatch returned it.
  store.attachRunHandle(runId, handle.native);
  return { runId, handle, spec };
}

/** Poll a running backend to a terminal phase, then fetch and persist the result. */
export async function awaitResult(
  store: LoomStore,
  backend: Backend,
  handle: RunHandle,
  opts: DispatchOptions = {},
): Promise<RunResult> {
  const maxPolls = opts.maxPolls ?? 100000;
  const delay = opts.pollDelayMs ?? 0;
  const now = opts.now ?? Date.now;
  const start = now();
  for (let i = 0; i < maxPolls; i++) {
    const status = await backend.poll(handle);
    if (status.phase === "completed" || status.phase === "errored" || status.phase === "cancelled" || status.phase === "timed_out") {
      const result = await backend.result(handle);
      store.recordRunResult(handle.runId, result);
      return result;
    }
    if (opts.wallClockMs !== undefined && now() - start >= opts.wallClockMs) {
      return timeout(store, backend, handle, `exceeded wall-clock budget ${opts.wallClockMs}ms`);
    }
    await sleep(delay);
  }
  return timeout(store, backend, handle, "exceeded max poll budget");
}

/** Cancel a run that blew its budget and record a timed_out result. */
async function timeout(store: LoomStore, backend: Backend, handle: RunHandle, message: string): Promise<RunResult> {
  await backend.cancel(handle);
  const timedOut: RunResult = {
    runId: handle.runId,
    status: "timed_out",
    error: { code: "timeout", message, retryable: true },
  };
  store.recordRunResult(handle.runId, timedOut);
  return timedOut;
}
