/**
 * Scheduler (ARCHITECTURE section 12). Selects a worker for a task by
 * capability, never by name.
 *
 * Two stages: a HARD-CONSTRAINT filter (availability, backend registered,
 * repository access, concurrency, cost ceiling) then a weighted capability
 * SCORE over the survivors (scoring.ts) with a historical-success feedback loop
 * and an exploration bonus. Weights are policy data. The operator's preference
 * is an additive prior in the score, not a hard override.
 */

import type { TaskDefinition } from "../domain/model.js";
import type { Registry, WorkerRecord } from "./registry.js";
import { DEFAULT_POLICY, scoreWorker, type ScoreContext, type SchedulerPolicy, type WorkerOutcome } from "./scoring.js";

const NO_OUTCOMES: ReadonlyMap<string, WorkerOutcome> = new Map();

export interface SchedulerInputs {
  readonly registry: Registry;
  /** Backend ids that are actually registered/usable right now. */
  readonly availableBackends: ReadonlySet<string>;
  /** current in-flight run count per workerId, for concurrency caps + load scoring. */
  readonly utilization: ReadonlyMap<string, number>;
  /** Per-worker accumulated outcomes (feeds historical_success + cost ceiling). */
  readonly outcomes?: ReadonlyMap<string, WorkerOutcome>;
  /** Scoring weights; defaults to DEFAULT_POLICY. */
  readonly policy?: SchedulerPolicy;
}

export interface SchedulerDecision {
  readonly worker: WorkerRecord;
  /** Why this worker (audit + future explainability). */
  readonly reason: string;
}

/** Hard constraints that filter the candidate set. A worker failing any is ineligible. */
function isEligible(worker: WorkerRecord, task: TaskDefinition, inputs: SchedulerInputs): boolean {
  if ((worker.availability ?? "available") !== "available") return false;
  if (!inputs.availableBackends.has(worker.backend)) return false;
  if (worker.repositoryAccess && !worker.repositoryAccess.includes(task.repo)) return false;
  const inFlight = inputs.utilization.get(worker.workerId) ?? 0;
  if (worker.concurrencyLimit !== undefined && inFlight >= worker.concurrencyLimit) return false;
  if (worker.costCeilingUsd !== undefined) {
    const spent = inputs.outcomes?.get(worker.workerId)?.costUsd ?? 0;
    if (spent >= worker.costCeilingUsd) return false; // over budget
  }
  return true;
}

/**
 * Select a worker. Returns null when no worker is eligible (the task waits in
 * the queue -- quality over throughput; we do not dispatch to an ineligible
 * worker just to keep busy).
 *
 * `preferredWorkerId` is an additive hint (the operator's preference). It never
 * overrides a hard constraint: a preferred-but-ineligible worker is skipped.
 */
export function selectWorker(
  task: TaskDefinition,
  inputs: SchedulerInputs,
  preferredWorkerId?: string,
  avoidWorkerId?: string,
): SchedulerDecision | null {
  const all = inputs.registry.list().filter((w) => isEligible(w, task, inputs));
  if (all.length === 0) return null;

  // Switch-worker-on-retry: prefer to avoid the worker that just failed, but if
  // it is the only eligible one, allow it (a retry on the same worker beats no
  // dispatch).
  const withoutAvoided = avoidWorkerId ? all.filter((w) => w.workerId !== avoidWorkerId) : all;
  const eligible = withoutAvoided.length > 0 ? withoutAvoided : all;

  const ctx: ScoreContext = {
    outcomes: inputs.outcomes ?? NO_OUTCOMES,
    utilization: inputs.utilization,
    policy: inputs.policy ?? DEFAULT_POLICY,
    ...(preferredWorkerId ? { preferredWorkerId } : {}),
  };

  // Rank by capability score; deterministic tie-break (cheaper, then id).
  const scored = eligible
    .map((w) => ({ w, ...scoreWorker(w, task, ctx) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (COST_RANK[a.w.costTier ?? "medium"] ?? 0.5) - (COST_RANK[b.w.costTier ?? "medium"] ?? 0.5) ||
        a.w.workerId.localeCompare(b.w.workerId),
    );
  const top = scored[0]!;
  return { worker: top.w, reason: `score ${top.score.toFixed(2)}: ${top.reason}` };
}

const COST_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** How suited a worker is to reviewing: explicit review strength, or a 'review' task-type preference. */
function reviewScore(worker: WorkerRecord): number {
  if (worker.strengths?.review !== undefined) return worker.strengths.review;
  return worker.preferredTaskTypes?.includes("review") ? 50 : 0;
}

/**
 * Select an INDEPENDENT reviewer (ARCHITECTURE section 17; IMPLEMENTATION-PLAN M2).
 *
 * Hard constraint: the reviewer is never the implementer. Among the remaining
 * eligible workers, route by review capability first (high review strength or a
 * 'review' task-type preference -- the "Sol for reviews" policy), and let cost
 * break ties. Returns null when no independent worker is available at all, so
 * the caller can escalate rather than allow a self-review.
 */
export function selectReviewer(
  task: TaskDefinition,
  inputs: SchedulerInputs,
  implementerWorkerId: string,
): SchedulerDecision | null {
  const candidates = inputs.registry
    .list()
    .filter((w) => w.workerId !== implementerWorkerId && isEligible(w, task, inputs));
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const byReview = reviewScore(b) - reviewScore(a);
    if (byReview !== 0) return byReview;
    return (COST_RANK[a.costTier ?? "medium"] ?? 1) - (COST_RANK[b.costTier ?? "medium"] ?? 1);
  });
  const chosen = sorted[0]!;
  const reason =
    reviewScore(chosen) > 0
      ? `review capability ${reviewScore(chosen)} (cost tiebreak)`
      : "independent reviewer (no review specialist available)";
  return { worker: chosen, reason };
}
