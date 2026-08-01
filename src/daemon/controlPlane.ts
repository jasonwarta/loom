/**
 * ControlPlane -- the daemon's core. Owns the queue, drives tasks through their
 * lifecycle via the scheduler + dispatcher, applies review, and reconciles
 * state on restart. Exposes the Dispatch API verbs (ARCHITECTURE section 10).
 *
 * M0 is single-process and drains synchronously on demand; the always-on
 * event loop, MCP transport, and monitoring are later milestones. The shape
 * here (verbs in, structured state out, everything durable) is what those build
 * on.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendError, type Backend } from "../contract/backend.js";
import type {
  IsolationUnit,
  ReviewFinding,
  ReviewResult,
  ReviewSpec,
  ReviewVerdict,
  RunHandle,
  RunResult,
  RunSpec,
} from "../contract/types.js";
import type { IsolationProvider } from "../isolation/worktree.js";
import type { DeliveryProvider } from "../delivery/delivery.js";
import type { LoomStore, StatusSummary } from "../persistence/store.js";
import type { Registry, WorkerRecord } from "../scheduler/registry.js";
import { selectReviewer, selectWorker } from "../scheduler/scheduler.js";
import { DEFAULT_POLICY, type SchedulerPolicy } from "../scheduler/scoring.js";
import { startRun, awaitResult, buildRunSpec, type DispatchOptions, type RunExtras } from "../dispatcher/dispatcher.js";
import type { Reviewer } from "../domain/review.js";
import { ContextTooLargeError, type ContextBuilder } from "../context/contextBuilder.js";
import { checkTaskReadiness, DEFAULT_READINESS, type ReadinessPolicy } from "../domain/readiness.js";
import { assertTaskTransition } from "../domain/stateMachine.js";
import { ShellVerifier, type VerificationOutcome, type Verifier } from "../verification/verifier.js";
import {
  TERMINAL_TASK_STATES,
  type RunRecord,
  type TaskDefinition,
  type TaskEvent,
  type TaskRecord,
  type TaskState,
} from "../domain/model.js";

/** task_meta keys for durable per-task operator/retry state. */
const META_PREFERRED_WORKER = "preferredWorker";
const META_AVOID_WORKER = "avoidWorker";
const META_REVISION_NOTES = "revisionNotes";
const META_REVISE_BRANCH = "reviseBranch";
const META_OPERATOR_NOTE = "operatorNote";

export interface ControlPlaneOptions {
  readonly store: LoomStore;
  readonly registry: Registry;
  readonly backends: ReadonlyMap<string, Backend>;
  /** Override the review mechanism (tests). Omit to use the platform reviewer (independent worker). */
  readonly reviewer?: Reviewer;
  readonly dispatch?: DispatchOptions;
  /**
   * Retry/revision bounds. Defaults: 3 implementer attempts, 2 revision loops,
   * 3 crashes. `maxCrashes` is a SEPARATE budget from `maxAttempts`: it counts
   * only runs that ended errored/timed_out (a worker that keeps crashing on the
   * same task), so a normal revision loop is never consumed by crash retries
   * and a crash-loop is stopped independently of the revision budget.
   */
  readonly retry?: { maxAttempts?: number; maxRevisions?: number; maxCrashes?: number };
  /** Optional per-run workspace isolation (e.g. git worktrees). Omit for mode "none". */
  readonly isolation?: IsolationProvider;
  /** Optional delivery of accepted work (push + PR). Omit to leave accepted work on its local branch. */
  readonly delivery?: DeliveryProvider;
  /** Optional context packaging. Omit to pass a bare task ref. */
  readonly contextBuilder?: ContextBuilder;
  /** Task-readiness gate policy. Defaults to the floor (description + acceptance criteria). */
  readonly readiness?: ReadinessPolicy;
  /** Capability-scheduling weights. Defaults to DEFAULT_POLICY. */
  readonly schedulerPolicy?: SchedulerPolicy;
  /**
   * Executes a task's `verificationCommand` in the committed worktree before
   * review. Defaults to a real shell runner; inject a fake in tests.
   */
  readonly verifier?: Verifier;
}

export interface SubmitInput {
  readonly definition: TaskDefinition;
  readonly preferredWorkerId?: string;
}

export interface TaskSummary {
  readonly id: string;
  readonly taskType: string;
  readonly state: TaskState;
  readonly priority: number;
  readonly deps: readonly string[];
}

export interface QueueView {
  readonly counts: Record<string, number>;
  readonly tasks: readonly TaskSummary[];
}

export interface TaskResultView {
  readonly task: TaskRecord;
  readonly runs: readonly RunRecord[];
  readonly results: Readonly<Record<string, unknown>>;
  /**
   * The task's full event history (state transitions with reasons, reviews,
   * escalations with reasons). This is how the operator learns WHY a task is
   * escalated/failed -- states alone don't carry reasons.
   */
  readonly events: readonly TaskEvent[];
}

export interface OpenEscalation {
  readonly id: string;
  readonly taskId: string;
  readonly reason: string;
  readonly raisedTo: string;
  readonly at: number;
}

export interface ReconcileReport {
  readonly adopted: number;
  readonly requeued: number;
  readonly ingested: number;
}

export class ControlPlane {
  private readonly store: LoomStore;
  private readonly registry: Registry;
  private readonly backends: ReadonlyMap<string, Backend>;
  /** Injected review override; when undefined, the platform reviewer (independent worker) is used. */
  private readonly reviewer: Reviewer | undefined;
  private readonly dispatchOpts: DispatchOptions;
  private readonly isolation: IsolationProvider | undefined;
  private readonly delivery: DeliveryProvider | undefined;
  private readonly contextBuilder: ContextBuilder | undefined;
  private readonly readiness: ReadinessPolicy;
  private readonly schedulerPolicy: SchedulerPolicy;
  private readonly maxAttempts: number;
  private readonly maxRevisions: number;
  private readonly maxCrashes: number;
  private readonly verifier: Verifier;
  /**
   * In-flight run count per worker, for concurrency caps. Live process state
   * (rebuilt naturally as runs start), NOT durable task state -- per-task
   * operator/retry state lives in the store's task_meta so it survives restarts.
   */
  private readonly utilization = new Map<string, number>();

  constructor(opts: ControlPlaneOptions) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.backends = opts.backends;
    this.reviewer = opts.reviewer;
    this.dispatchOpts = opts.dispatch ?? {};
    this.isolation = opts.isolation;
    this.delivery = opts.delivery;
    this.contextBuilder = opts.contextBuilder;
    this.readiness = opts.readiness ?? DEFAULT_READINESS;
    this.schedulerPolicy = opts.schedulerPolicy ?? DEFAULT_POLICY;
    this.maxAttempts = opts.retry?.maxAttempts ?? 3;
    this.maxRevisions = opts.retry?.maxRevisions ?? 2;
    this.maxCrashes = opts.retry?.maxCrashes ?? 3;
    this.verifier = opts.verifier ?? new ShellVerifier();
  }

  // ---------------------------------------------------------------------------
  // Dispatch API (ARCHITECTURE section 10)
  // ---------------------------------------------------------------------------

  /** DispatchWorker: submit a task for scheduling + execution. Returns the task id. */
  dispatchWorker(input: SubmitInput): string {
    const id = randomUUID();
    this.store.createTask(id, input.definition);
    if (input.preferredWorkerId !== undefined) this.store.setTaskMeta(id, META_PREFERRED_WORKER, input.preferredWorkerId);

    // Readiness gate: an underspecified task never reaches a worker. It escalates
    // at admission so the gap is surfaced, not silently dispatched.
    const readiness = checkTaskReadiness(input.definition, this.readiness);
    if (!readiness.ready) {
      this.store.recordEscalation(randomUUID(), id, `not dispatch-ready: ${readiness.reasons.join("; ")}`, "operator");
      this.transition(id, "created", "escalated", "failed readiness gate");
      return id;
    }

    if (this.depsSatisfied(input.definition.deps)) {
      this.transition(id, "created", "queued", "admitted");
    }
    return id;
  }

  /** QueryQueue: pending/running tasks + counts. */
  queryQueue(): QueueView {
    const tasks = this.store.listTasks();
    const counts: Record<string, number> = {};
    const summaries: TaskSummary[] = [];
    for (const t of tasks) {
      counts[t.state] = (counts[t.state] ?? 0) + 1;
      summaries.push({
        id: t.id,
        taskType: t.definition.taskType,
        state: t.state,
        priority: t.definition.priority,
        deps: t.definition.deps,
      });
    }
    return { counts, tasks: summaries };
  }

  /** QueryRegistry: available workers + profiles. */
  queryRegistry(): WorkerRecord[] {
    return this.registry.list();
  }

  /**
   * Status: aggregate operational snapshot (store-derived) + live per-worker
   * utilization + open escalations WITH their reasons (the operator acts on
   * these; a bare count is not actionable).
   */
  getStatus(): StatusSummary & { utilization: Record<string, number>; openEscalations: OpenEscalation[] } {
    return {
      ...this.store.status(),
      utilization: Object.fromEntries(this.utilization),
      openEscalations: this.store.listOpenEscalations(),
    };
  }

  /** InspectWorker: one worker + live utilization. */
  inspectWorker(workerId: string): { worker: WorkerRecord; inFlight: number } | null {
    const worker = this.registry.get(workerId);
    if (!worker) return null;
    return { worker, inFlight: this.utilization.get(workerId) ?? 0 };
  }

  /** GetResult: a task's runs + results + full event history (incl. escalation reasons). */
  getResult(taskId: string): TaskResultView | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const runs = this.store.listRunsByTask(taskId);
    const results: Record<string, unknown> = {};
    for (const r of runs) {
      const res = this.store.getResult(r.runId);
      if (res) results[r.runId] = res;
    }
    return { task, runs, results, events: this.store.getEvents(taskId) };
  }

  /** CancelTask: cancel a non-terminal task (and its in-flight run, best effort). */
  async cancelTask(taskId: string, reason: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task || TERMINAL_TASK_STATES.has(task.state)) return false;
    // Cancel any live run for this task.
    for (const run of this.store.listRunsByTask(taskId)) {
      if (run.state === "running" || run.state === "dispatching") {
        const backend = this.backends.get(run.backendId);
        if (backend && run.nativeHandle) {
          await backend.cancel(this.handleOf(run));
        }
        this.store.setRunState(run.runId, "cancelled");
      }
    }
    // Route to the cancelled terminal state via a legal path.
    this.forceTo(taskId, "cancelled", reason);
    return true;
  }

  /**
   * ResumeTask: re-queue a waiting/failed/escalated task. The addendum is
   * persisted and included in the next run's prompt as an operator note --
   * this is how the operator answers a blocked worker's question or steers a
   * retry. Resuming also resolves the task's open escalations (the operator
   * has acted on them).
   */
  resumeTask(taskId: string, addendum?: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    if (addendum !== undefined && addendum.trim().length > 0) {
      this.store.setTaskMeta(taskId, META_OPERATOR_NOTE, addendum.trim());
    }
    if (task.state === "waiting") {
      // No live backend run exists to rejoin (a blocked run is terminal for the
      // CLI backends), so a resume re-queues the task as a fresh run.
      this.transition(taskId, "waiting", "queued", "resumed by operator");
      return true;
    }
    if (task.state === "failed" || task.state === "escalated") {
      this.store.resolveEscalations(taskId, "operator resumed the task");
      this.requeue(taskId, "resume");
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------------

  /**
   * Drain the queue: process dispatch-eligible tasks until no progress can be
   * made (all done, or blocked on workers/deps/waiting).
   *
   * Slot pool, not batches: a new task starts as soon as a slot frees, so one
   * long-running task never idles the other slots (the old fixed-batch barrier
   * did exactly that). Tasks that could not dispatch (no eligible worker) are
   * deferred and retried only after some other task finishes -- that is the
   * only event that can change eligibility -- which also prevents busy-spin.
   */
  async drain(opts: { concurrency?: number } = {}): Promise<void> {
    const concurrency = opts.concurrency ?? 4;
    const inFlight = new Map<string, Promise<void>>();
    const deferred = new Set<string>();
    let progressed = false;

    for (;;) {
      this.admitReadyTasks();
      const candidates = this.eligibleQueued().filter((t) => !inFlight.has(t.id) && !deferred.has(t.id));
      for (const t of candidates) {
        if (inFlight.size >= concurrency) break;
        const p = this.processTask(t.id)
          .then((worked) => {
            if (worked) progressed = true;
            else deferred.add(t.id);
          })
          .catch((err) => {
            // Defer, don't count as progress: a deterministically-throwing task
            // must not hot-loop when nothing else is running. It is retried
            // after some other task completes, like any deferred task.
            if (process.env.LOOM_DEBUG) console.error("drain: processTask threw:", err);
            deferred.add(t.id);
          })
          .finally(() => {
            inFlight.delete(t.id);
          });
        inFlight.set(t.id, p);
      }
      if (inFlight.size === 0) break; // nothing running and nothing startable
      await Promise.race(inFlight.values());
      if (progressed) {
        deferred.clear(); // a task completed -> capacity/deps changed -> retry deferred
        progressed = false;
      }
    }
  }

  /** Process one queued task through dispatch -> run -> review. Returns true if it dispatched. */
  private async processTask(taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "queued") return false;

    const decision = selectWorker(
      task.definition,
      this.schedulerInputs(),
      this.store.getTaskMeta(taskId, META_PREFERRED_WORKER),
      this.store.getTaskMeta(taskId, META_AVOID_WORKER),
    );
    if (!decision) return false; // no eligible worker; leave queued

    const backend = this.backends.get(decision.worker.backend);
    if (!backend) return false;

    const runId = randomUUID();
    let unit: IsolationUnit = { mode: "none" };

    // Effective resume target: operator-declared recovery branch, or -- on a
    // revision run -- the prior attempt's branch, so the worker revises the
    // actual code the review findings refer to instead of restarting from base.
    const resumeBranch = task.definition.resumeFromBranch ?? this.store.getTaskMeta(taskId, META_REVISE_BRANCH);

    // Build the context package while the task is still queued, so a package
    // that cannot fit the worker escalates instead of dispatching a doomed run.
    let contextRef: string | undefined;
    if (this.contextBuilder) {
      try {
        contextRef = (
          await this.contextBuilder.build(task, decision.worker, resumeBranch !== undefined ? { resumeBranch } : {})
        ).ref;
      } catch (err) {
        if (err instanceof ContextTooLargeError) {
          this.store.recordEscalation(randomUUID(), taskId, err.message, "operator");
          this.transition(taskId, "queued", "escalated", "context too large; decompose further");
          return true;
        }
        throw err;
      }
    }

    this.transition(taskId, "queued", "dispatched", decision.reason);
    this.incUtil(decision.worker.workerId);
    try {
      if (this.isolation) {
        try {
          unit = await this.isolation.acquire(runId, task.definition.repo, task.definition.baseBranch, resumeBranch);
        } catch (err) {
          // Isolation acquisition fails BEFORE startRun records a run, so without
          // this the crash/attempt counters (which count run rows) never see the
          // attempt and the task re-queues forever. Record the failed setup as an
          // errored run: it is now counted (bounding the retry loop), diagnosable
          // (visible in GetResult), and durable.
          const spec = buildRunSpec(task, decision.worker, runId, { mode: "none" }, contextRef);
          this.store.recordRunIntent({
            runId,
            taskId,
            workerId: decision.worker.workerId,
            backendId: backend.id,
            runSpec: spec,
          });
          this.store.recordRunResult(runId, {
            runId,
            status: "errored",
            error: { code: "transient", message: `isolation acquire failed: ${String(err)}`, retryable: true },
          });
          throw err; // fall through to the outer catch -> handleRunFailure (now with a counted run)
        }
      }
      const notes = this.composeNotes(taskId);
      const extras: RunExtras = {
        ...(notes !== undefined ? { priorNotes: notes } : {}),
        ...(resumeBranch !== undefined ? { resumedWork: true } : {}),
      };
      const { handle } = await startRun(
        this.store,
        backend,
        task,
        decision.worker,
        runId,
        unit,
        contextRef,
        extras,
      );
      // The operator note was delivered to this run; it must not leak into later retries.
      this.store.deleteTaskMeta(taskId, META_OPERATOR_NOTE);
      this.transition(taskId, "dispatched", "running", `run ${runId}`);
      await this.finishRun(taskId, runId, handle, backend, decision.worker.workerId, unit);
    } catch (err) {
      // Dispatch/isolation failed; run already marked errored by the dispatcher if it started.
      if (process.env.LOOM_DEBUG) console.error("processTask error:", err);
      const retryable = err instanceof BackendError ? err.retryable : true;
      this.handleRunFailure(taskId, decision.worker.workerId, `dispatch failed: ${String(err)}`, { retryable });
    } finally {
      this.decUtil(decision.worker.workerId);
      if (this.isolation) await this.isolation.release(unit);
    }
    return true;
  }

  /** Compose the pre-labeled notes block for a run: revision findings + operator note. */
  private composeNotes(taskId: string): string | undefined {
    const sections: string[] = [];
    const findings = this.store.getTaskMeta(taskId, META_REVISION_NOTES);
    if (findings !== undefined) sections.push(`## Prior review findings to address\n${findings}`);
    const note = this.store.getTaskMeta(taskId, META_OPERATOR_NOTE);
    if (note !== undefined) sections.push(`## Operator note\n${note}`);
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  /** Await a started run's result and apply the retry / review -> task-state flow. */
  private async finishRun(
    taskId: string,
    runId: string,
    handle: RunHandle,
    backend: Backend,
    implementerWorkerId: string,
    unit: IsolationUnit,
  ): Promise<void> {
    const wall = this.store.getRun(runId)?.runSpec.constraints.wallClockMs;
    const result = await awaitResult(this.store, backend, handle, {
      ...this.dispatchOpts,
      ...(wall !== undefined ? { wallClockMs: wall } : {}),
    });

    if (result.status === "blocked") {
      this.transition(taskId, "running", "waiting", "worker blocked");
      return;
    }
    if (result.status !== "completed") {
      // Carry the worker's diagnosable reason (exit code + signal + stderr tail)
      // through to the retry/escalation record instead of just the status word.
      const reason = result.error ? `run ${result.status}: ${result.error.message}` : `run ${result.status}`;
      this.handleRunFailure(taskId, implementerWorkerId, reason, { retryable: result.error?.retryable ?? true });
      return;
    }

    // Capture the work: commit the worktree to its branch BEFORE review, so the
    // reviewer sees committed changes and release doesn't discard them.
    if (this.isolation) await this.isolation.commit(unit, `loom: task ${taskId} (run ${runId.slice(0, 8)})`);

    // Empty-run guard: an implementation run that "completed" without putting
    // ANY work on its branch is a failed run, not a reviewable one -- the
    // signature of a worker that stalled or asked a question into the void.
    // Catching it here saves a wasted reviewer run and retries on another
    // worker. Not applied to non-implementation types (an investigation's
    // deliverable is its final message, not a branch).
    const guardTask = this.store.getTask(taskId)!;
    if (
      unit.mode === "worktree" &&
      this.isolation?.hasNewWork &&
      guardTask.definition.taskType.toLowerCase().includes("implement") &&
      !(await this.isolation.hasNewWork(unit, guardTask.definition.baseBranch))
    ) {
      this.handleRunFailure(
        taskId,
        implementerWorkerId,
        "run completed but produced no changes (worker likely stalled or asked a question)",
      );
      return;
    }

    // completed -> review -> (accept | revise | reject)
    this.transition(taskId, "running", "review", "result received");
    const task = this.store.getTask(taskId)!;
    const run = this.store.getRun(runId)!;

    // Execute the task's verification command (if any) in the committed
    // worktree BEFORE spending a reviewer run. A failing check is an objective
    // revise -- no LLM judgment involved; a passing check is surfaced to the
    // reviewer so the review can focus on semantics.
    let verification: VerificationOutcome | undefined;
    if (task.definition.verificationCommand && unit.mode === "worktree") {
      verification = await this.verifier.run(task.definition.verificationCommand, unit.path);
      this.store.recordMetric("verification", verification.ok ? 1 : 0, { taskId });
    }

    let verdict: ReviewResult | null;
    if (verification && !verification.ok) {
      verdict = {
        verdict: "revise",
        findings: [
          {
            severity: "S0",
            title: `verification command failed (exit ${verification.exitCode ?? "?"})`,
            detail: `\`${task.definition.verificationCommand}\` in the run's worktree:\n${verification.output}`,
          },
        ],
      };
    } else {
      verdict = this.reviewer
        ? await this.reviewer.review(task, run, result)
        : await this.platformReview(task, run, result, implementerWorkerId, unit, verification);
    }

    if (!verdict) {
      this.store.recordEscalation(randomUUID(), taskId, "no independent reviewer available", "operator");
      this.escalate(taskId, "no independent reviewer");
      return;
    }

    const priorRevisions = this.countRevisions(taskId); // before recording the current verdict
    this.store.recordReview(randomUUID(), taskId, runId, null, verdict);

    switch (verdict.verdict) {
      case "accept": {
        this.store.deleteTaskMeta(taskId, META_AVOID_WORKER);
        this.store.deleteTaskMeta(taskId, META_REVISION_NOTES);
        this.store.deleteTaskMeta(taskId, META_REVISE_BRANCH);
        const reason = await this.deliverAccepted(taskId, unit, task);
        this.transition(taskId, "review", "completed", reason);
        break;
      }
      case "revise":
        if (priorRevisions < this.maxRevisions) {
          this.store.setTaskMeta(taskId, META_REVISION_NOTES, formatFindings(verdict.findings));
          // The revision must continue THIS run's branch (the committed work the
          // findings refer to), not restart from the base branch.
          if (unit.mode === "worktree") this.store.setTaskMeta(taskId, META_REVISE_BRANCH, unit.branch);
          this.transition(taskId, "review", "revision_requested", `revise ${priorRevisions + 1}/${this.maxRevisions}`);
          this.transition(taskId, "revision_requested", "queued", "re-queued for revision");
        } else {
          this.store.recordEscalation(randomUUID(), taskId, `revision budget exhausted (${this.maxRevisions})`, "operator");
          this.escalate(taskId, "revision budget exhausted");
        }
        break;
      case "reject":
        this.store.recordEscalation(randomUUID(), taskId, "review rejected the result", "operator");
        this.escalate(taskId, "review rejected");
        break;
    }
  }

  /**
   * Deliver accepted work: push the branch and open a PR. This runs platform-side
   * (unsandboxed, where network + gh auth live), never in the worker. The work is
   * already committed on the branch (finishRun commits before review), so a
   * delivery failure is NOT fatal -- it is recorded as an open escalation for a
   * human to push, while the task still completes. Returns the reason string to
   * record on the completion transition.
   */
  private async deliverAccepted(taskId: string, unit: IsolationUnit, task: TaskRecord): Promise<string> {
    if (!this.delivery || unit.mode !== "worktree") return "review accepted";
    const title = task.definition.description.split("\n")[0]!.slice(0, 72);
    const body = [
      task.definition.description,
      "",
      "## Acceptance criteria",
      ...task.definition.acceptanceCriteria.map((c) => `- ${c}`),
      "",
      `_Delivered by Loom (task ${taskId})._`,
    ].join("\n");
    try {
      const outcome = await this.delivery.publish(unit, {
        taskId,
        title,
        body,
        baseBranch: task.definition.baseBranch,
      });
      if (outcome.prUrl) return `review accepted; PR ${outcome.prUrl}`;
      if (outcome.pushed) return `review accepted; pushed ${unit.branch}`;
      return "review accepted";
    } catch (err) {
      const msg = `delivery failed: ${String(err)}; branch ${unit.branch} is committed and ready to push manually`;
      this.store.recordEscalation(randomUUID(), taskId, msg, "operator");
      if (process.env.LOOM_DEBUG) console.error("deliverAccepted error:", err);
      return `review accepted; ${msg}`;
    }
  }

  /**
   * Retry-or-escalate on a failed/timed-out run (switch-worker-on-retry).
   *
   * The orchestrator inspects the failure's close condition rather than blindly
   * relaunching:
   *  - a NON-RETRYABLE failure (e.g. the CLI binary is missing) escalates at
   *    once -- retrying cannot fix a config fault;
   *  - repeated CRASHES on the same task (errored/timed_out runs) escalate once
   *    the crash budget is hit, so a worker that keeps dying on this task does
   *    not loop forever;
   *  - otherwise the overall attempt budget still bounds retries.
   * The full diagnosable `reason` (exit code + signal + stderr tail) is recorded
   * on the escalation and the retry event, so the operator learns WHY.
   */
  private handleRunFailure(taskId: string, workerId: string, reason: string, opts: { retryable?: boolean } = {}): void {
    if (opts.retryable === false) {
      this.store.recordEscalation(randomUUID(), taskId, `non-retryable failure: ${reason}`, "operator");
      this.escalate(taskId, "non-retryable failure");
      return;
    }

    const crashes = this.crashAttempts(taskId); // includes the run that just failed
    if (crashes >= this.maxCrashes) {
      this.store.recordEscalation(
        randomUUID(),
        taskId,
        `worker crashed ${crashes} time(s) on this task (limit ${this.maxCrashes}): ${reason}`,
        "operator",
      );
      this.escalate(taskId, `crashed ${crashes} times`);
      return;
    }

    const attempts = this.implementerAttempts(taskId);
    if (attempts < this.maxAttempts) {
      this.store.setTaskMeta(taskId, META_AVOID_WORKER, workerId); // avoid the worker that just failed
      this.requeue(taskId, `retry ${attempts}/${this.maxAttempts}: ${reason}`);
    } else {
      this.store.recordEscalation(randomUUID(), taskId, `exhausted ${this.maxAttempts} attempts: ${reason}`, "operator");
      this.escalate(taskId, "attempts exhausted");
    }
  }

  /** Run a real independent review on a platform-selected reviewer worker. */
  private async platformReview(
    task: TaskRecord,
    implementerRun: RunRecord,
    result: RunResult,
    implementerWorkerId: string,
    unit: IsolationUnit,
    verification?: VerificationOutcome,
  ): Promise<ReviewResult | null> {
    const decision = selectReviewer(task.definition, this.schedulerInputs(), implementerWorkerId);
    if (!decision) return null;
    const backend = this.backends.get(decision.worker.backend);
    if (!backend) return null;

    const caps = backend.capabilities();
    if (caps.supportsNativeReview && backend.review) {
      const spec: ReviewSpec = {
        taskId: task.id,
        runId: implementerRun.runId,
        target:
          implementerRun.runSpec.isolationUnit.mode === "worktree"
            ? { type: "baseBranch", branch: implementerRun.runSpec.baseBranch }
            : { type: "uncommitted" },
        acceptanceCriteria: task.definition.acceptanceCriteria,
        ...(result.branchRef ? { diffRef: result.branchRef } : {}),
      };
      return backend.review(spec);
    }
    return this.dispatchedReview(task, decision.worker, backend, result, unit, verification);
  }

  /** Review via a dispatched review run, for backends without native review (e.g. Claude). */
  private async dispatchedReview(
    task: TaskRecord,
    reviewer: WorkerRecord,
    backend: Backend,
    result: RunResult,
    unit: IsolationUnit,
    verification?: VerificationOutcome,
  ): Promise<ReviewResult> {
    const reviewRunId = randomUUID();
    // The reviewer runs IN the implementer's worktree (still alive here --
    // release happens after review): its cwd is a checkout of the branch under
    // review, with a read-only policy so it cannot mutate what it judges. With
    // no worktree (e.g. reconciled runs), fall back to the repo path as cwd.
    const spec: RunSpec = {
      runId: reviewRunId,
      taskId: task.id,
      taskType: "review",
      effort: "medium",
      modelPreference: reviewer.model,
      contextPackageRef: writeReviewBrief(task, result, unit, verification),
      repo: task.definition.repo,
      baseBranch: task.definition.baseBranch,
      isolationUnit: unit.mode === "worktree" ? unit : { mode: "none" },
      isolationPolicy: { writeScope: "read-only", networkEgress: "none" },
      constraints: {},
      expectedDeliverables: ["verdict"],
      outputSchema: VERDICT_SCHEMA,
    };
    this.store.recordRunIntent({
      runId: reviewRunId,
      taskId: task.id,
      workerId: reviewer.workerId,
      backendId: backend.id,
      runSpec: spec,
    });
    const handle = await backend.dispatch(spec);
    this.store.attachRunHandle(reviewRunId, handle.native);
    const runResult = await awaitResult(this.store, backend, handle, this.dispatchOpts);
    return parseVerdict(runResult);
  }

  private implementerAttempts(taskId: string): number {
    return this.store.listRunsByTask(taskId).filter((r) => r.runSpec.taskType !== "review").length;
  }

  /**
   * Implementer runs that ended in a crash (errored/timed_out). Distinct from
   * `implementerAttempts`: a task that revised twice then crashed once has 3
   * attempts but 1 crash. recordRunResult has already set the just-failed run's
   * state by the time this is called, so it counts that run.
   */
  private crashAttempts(taskId: string): number {
    return this.store
      .listRunsByTask(taskId)
      .filter((r) => r.runSpec.taskType !== "review" && (r.state === "errored" || r.state === "timed_out")).length;
  }

  private countRevisions(taskId: string): number {
    return this.store.getEvents(taskId).filter((e) => e.type === "review" && e.data["verdict"] === "revise").length;
  }

  /** Route a task to `escalated` from wherever it is, via legal transitions. */
  private escalate(taskId: string, reason: string): void {
    const s = this.store.getTask(taskId)?.state;
    if (!s) return;
    if (s === "running" || s === "dispatched" || s === "review") {
      this.transition(taskId, s, "failed", reason);
      this.transition(taskId, "failed", "escalated", reason);
    } else if (s === "queued" || s === "created" || s === "waiting" || s === "failed") {
      this.transition(taskId, s, "escalated", reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Reconciliation (restart recovery) -- ARCHITECTURE section 15, 20
  // ---------------------------------------------------------------------------

  /**
   * Reconcile persisted in-flight runs against their backends after a restart.
   * - `dispatching` orphans (crash between write-ahead intent and handle
   *   backfill): adopt via findRun if the backend started them, else re-queue.
   * - `running` runs (crash mid-await): ingest if terminal; resume if the
   *   backend is cross-restart-recoverable; else re-queue as a fresh run.
   */
  async recover(): Promise<ReconcileReport> {
    let adopted = 0;
    let requeued = 0;
    let ingested = 0;

    for (const run of this.store.listRunsByState("dispatching")) {
      const backend = this.backends.get(run.backendId);
      if (!backend) {
        this.store.setRunState(run.runId, "errored");
        this.requeue(run.taskId, "reconcile: unknown backend");
        requeued++;
        continue;
      }
      const handle = await backend.findRun(run.runId);
      if (handle) {
        this.store.attachRunHandle(run.runId, handle.native); // -> running
        if (this.store.getTask(run.taskId)?.state === "dispatched") {
          this.transition(run.taskId, "dispatched", "running", "reconcile: adopted orphan");
        }
        await this.finishRun(run.taskId, run.runId, handle, backend, run.workerId, { mode: "none" });
        adopted++;
      } else {
        this.store.setRunState(run.runId, "errored");
        this.requeue(run.taskId, "reconcile: dispatch never took effect");
        requeued++;
      }
    }

    for (const run of this.store.listRunsByState("running")) {
      const backend = this.backends.get(run.backendId);
      if (!backend || !run.nativeHandle) {
        this.store.setRunState(run.runId, "errored");
        this.requeue(run.taskId, "reconcile: unrecoverable running run");
        requeued++;
        continue;
      }
      // A non-durable backend's in-process run did not survive the restart:
      // re-queue as a fresh run rather than trying (and failing) to poll it.
      if (!backend.capabilities().crossRestartRecoverable) {
        this.store.setRunState(run.runId, "errored");
        this.requeue(run.taskId, "reconcile: non-durable backend, re-queue as fresh run");
        requeued++;
        continue;
      }
      const handle = this.handleOf(run);
      let status;
      try {
        status = await backend.poll(handle);
      } catch {
        this.store.setRunState(run.runId, "errored");
        this.requeue(run.taskId, "reconcile: run not found on backend");
        requeued++;
        continue;
      }
      const terminal =
        status.phase === "completed" ||
        status.phase === "errored" ||
        status.phase === "cancelled" ||
        status.phase === "timed_out";
      if (terminal) {
        await this.finishRun(run.taskId, run.runId, handle, backend, run.workerId, { mode: "none" });
        ingested++;
      } else {
        await this.finishRun(run.taskId, run.runId, handle, backend, run.workerId, { mode: "none" });
        adopted++;
      }
    }

    return { adopted, requeued, ingested };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private schedulerInputs() {
    return {
      registry: this.registry,
      availableBackends: new Set(this.backends.keys()),
      utilization: this.utilization,
      outcomes: this.store.workerOutcomes(),
      policy: this.schedulerPolicy,
    };
  }

  /** Dispatch-eligible queued tasks, highest priority first (age breaks ties). */
  private eligibleQueued(): TaskRecord[] {
    return this.store
      .listTasksByState("queued")
      .filter((t) => this.depsSatisfied(t.definition.deps))
      .sort((a, b) => b.definition.priority - a.definition.priority || a.createdAt - b.createdAt);
  }

  /** Promote created tasks whose deps are now satisfied to queued. */
  private admitReadyTasks(): void {
    for (const t of this.store.listTasksByState("created")) {
      if (this.depsSatisfied(t.definition.deps)) {
        this.transition(t.id, "created", "queued", "deps satisfied");
      }
    }
  }

  private depsSatisfied(deps: readonly string[]): boolean {
    return deps.every((d) => this.store.getTask(d)?.state === "completed");
  }

  private transition(taskId: string, from: TaskState, to: TaskState, reason: string): void {
    assertTaskTransition(from, to);
    this.store.setTaskState(taskId, to, reason);
  }

  /** Re-queue a task from a failure/recovery state via the legal failed->retry->queued path. */
  private requeue(taskId: string, reason: string): void {
    const t = this.store.getTask(taskId);
    if (!t) return;
    if (t.state === "dispatched" || t.state === "running") {
      this.store.setTaskState(taskId, "failed", reason);
    }
    const now = this.store.getTask(taskId)!.state;
    if (now === "failed" || now === "escalated") {
      this.store.setTaskState(taskId, "retry", reason);
      this.store.setTaskState(taskId, "queued", reason);
    }
  }

  /** Move a task to a target state from wherever it is now, asserting the transition is legal. */
  private forceTo(taskId: string, to: TaskState, reason: string): void {
    const t = this.store.getTask(taskId);
    if (!t) return;
    this.transition(taskId, t.state, to, reason);
  }

  private handleOf(run: RunRecord): RunHandle {
    return {
      runId: run.runId,
      backendId: run.backendId,
      native: run.nativeHandle ?? {},
      createdAt: run.createdAt,
    };
  }

  private incUtil(workerId: string): void {
    this.utilization.set(workerId, (this.utilization.get(workerId) ?? 0) + 1);
  }

  private decUtil(workerId: string): void {
    this.utilization.set(workerId, Math.max(0, (this.utilization.get(workerId) ?? 0) - 1));
  }
}

// --- review helpers (module scope) ---

/** A minimal JSON schema for a structured review verdict (used by backends that honor outputSchema). */
const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["accept", "revise", "reject"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { severity: { type: "string" }, title: { type: "string" }, detail: { type: "string" } },
      },
    },
  },
} as const;

function formatFindings(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return "(no specific findings provided)";
  return findings.map((f) => `- [${f.severity}] ${f.title}${f.detail ? `: ${f.detail}` : ""}`).join("\n");
}

/** Write a review brief to a file the reviewer's adapter will read as its context. */
function writeReviewBrief(
  task: TaskRecord,
  result: RunResult,
  unit: IsolationUnit,
  verification?: VerificationOutcome,
): string {
  const dir = join(tmpdir(), "loom-review");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `review-${task.id}-${randomUUID().slice(0, 8)}.md`);
  const base = task.definition.baseBranch;
  const artifact =
    unit.mode === "worktree"
      ? `Your working directory IS a checkout of the implementation branch \`${unit.branch}\` (read-only). ` +
        `Inspect the work with \`git log ${base}..HEAD\`, \`git diff ${base}...HEAD\`, and by reading the files.`
      : result.branchRef
        ? `The implementation is on git branch \`${result.branchRef}\`. Inspect it with \`git diff ${base}..${result.branchRef}\` (or \`git log\`/\`git show\` on that branch).`
        : "Review the uncommitted changes in the workspace.";
  const body = [
    `# Review task ${task.id}`,
    `You are an INDEPENDENT reviewer running HEADLESS -- no human will answer questions, so never ask any; judge with what is in front of you. Judge the implementation against the acceptance criteria.`,
    `## Acceptance criteria`,
    task.definition.acceptanceCriteria.map((c) => `- ${c}`).join("\n"),
    `## Artifact`,
    artifact,
    ...(verification
      ? [
          `## Verification`,
          `The platform already ran the task's verification command (\`${task.definition.verificationCommand}\`) in this checkout and it PASSED. Focus your review on semantics: does the implementation actually satisfy each acceptance criterion, is it correct beyond what the check covers, is anything missing.`,
        ]
      : []),
    `## Output`,
    'Respond with ONLY a JSON object on its own, no prose around it:\n`{"verdict": "accept" | "revise" | "reject", "findings": [{"severity": "S0"|"S1"|"S2", "title": "...", "detail": "..."}]}`\nAccept only if every acceptance criterion is met.',
  ].join("\n\n");
  writeFileSync(path, body, "utf8");
  return path;
}

/** Parse a dispatched review run's result into a verdict. Never accept an unparseable review. */
function parseVerdict(runResult: RunResult): ReviewResult {
  // 1) Structured deliverables (backends that honor outputSchema, e.g. the fake).
  const fromObj = coerceVerdict(runResult.deliverables);
  if (fromObj) return fromObj;
  // 2) A JSON object embedded in the final message (real CLIs return prose+JSON).
  const embedded = extractJsonObject(runResult.finalMessage);
  const fromMsg = coerceVerdict(embedded);
  if (fromMsg) return fromMsg;
  return { verdict: "reject", findings: [{ severity: "S1", title: "review produced no parseable verdict" }] };
}

function coerceVerdict(obj: unknown): ReviewResult | null {
  if (!obj || typeof obj !== "object") return null;
  const raw = (obj as Record<string, unknown>)["verdict"];
  if (raw !== "accept" && raw !== "revise" && raw !== "reject") return null;
  const rawFindings = (obj as Record<string, unknown>)["findings"];
  const findings = Array.isArray(rawFindings) ? (rawFindings as ReviewFinding[]) : [];
  return { verdict: raw as ReviewVerdict, findings };
}

/** Extract the first parseable top-level JSON object from a text blob. */
function extractJsonObject(text: string | undefined): unknown {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
