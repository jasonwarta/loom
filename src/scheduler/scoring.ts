/**
 * Capability-based scoring (ARCHITECTURE section 12; IMPLEMENTATION-PLAN M4).
 *
 * Selection is: hard-constraint filter (scheduler.ts) -> rank survivors by this
 * weighted score. The weights are POLICY DATA, tunable without code change. The
 * score routes by required capability first and lets cost break in -- so an
 * expensive high-reasoning worker wins hard tasks but loses trivial ones (the
 * cost-tier point). historical_success is a feedback loop; an exploration bonus
 * keeps new/under-sampled workers from being starved.
 */

import type { Effort } from "../contract/types.js";
import type { TaskDefinition } from "../domain/model.js";
import type { WorkerRecord } from "./registry.js";

/** Accumulated outcome history for a worker (from the store). */
export interface WorkerOutcome {
  readonly total: number;
  readonly completed: number;
  readonly costUsd: number;
}

export interface SchedulerPolicy {
  readonly wCapability: number;
  readonly wPreferredType: number;
  readonly wHistory: number;
  readonly wPreference: number;
  readonly wCost: number;
  readonly wLatency: number;
  readonly wLoad: number;
  readonly explorationBonus: number;
  /** Workers with fewer than this many outcomes get the exploration bonus. */
  readonly explorationSampleFloor: number;
}

export const DEFAULT_POLICY: SchedulerPolicy = {
  wCapability: 1.0,
  wPreferredType: 0.5,
  wHistory: 0.6,
  wPreference: 0.8,
  wCost: 0.5,
  wLatency: 0.2,
  wLoad: 0.3,
  explorationBonus: 0.4,
  explorationSampleFloor: 3,
};

export interface Requirements {
  /** The capability dimension the task most needs. */
  readonly dimension: "coding" | "reasoning" | "review" | "investigation";
  /** How much cheapness matters (high for trivial work, low for hard work). */
  readonly costSensitivity: number;
  readonly latencySensitivity: number;
}

const EFFORT_COST_SENSITIVITY: Record<Effort, number> = {
  none: 1.0,
  minimal: 1.0,
  low: 0.85,
  medium: 0.6,
  high: 0.25,
  xhigh: 0.1,
};

/** Derive what a task needs from its type + effort (no explicit per-task profile required). */
export function deriveRequirements(task: TaskDefinition): Requirements {
  const t = task.taskType.toLowerCase();
  const dimension: Requirements["dimension"] = t.includes("review")
    ? "review"
    : t.includes("investigat")
      ? "investigation"
      : t.includes("architect") || t.includes("hard")
        ? "reasoning"
        : "coding";
  return {
    dimension,
    costSensitivity: EFFORT_COST_SENSITIVITY[task.effort],
    latencySensitivity: 0.3,
  };
}

const COST_RANK: Record<string, number> = { low: 0, medium: 0.5, high: 1 };
const LAT_RANK: Record<string, number> = { fast: 0, medium: 0.5, slow: 1 };

export interface ScoreContext {
  readonly outcomes: ReadonlyMap<string, WorkerOutcome>;
  readonly utilization: ReadonlyMap<string, number>;
  readonly policy: SchedulerPolicy;
  readonly preferredWorkerId?: string;
}

export interface ScoreBreakdown {
  readonly score: number;
  readonly reason: string;
}

export function scoreWorker(worker: WorkerRecord, task: TaskDefinition, ctx: ScoreContext): ScoreBreakdown {
  const req = deriveRequirements(task);
  const p = ctx.policy;

  // Capability: worker's strength in the needed dimension (0..1), neutral 0.5 if undeclared.
  const strength = worker.strengths?.[req.dimension];
  const capability = (typeof strength === "number" ? strength : 50) / 100;

  const typeMatch = worker.preferredTaskTypes?.includes(task.taskType) ? 1 : 0;

  const outcome = ctx.outcomes.get(worker.workerId);
  const history = outcome && outcome.total > 0 ? outcome.completed / outcome.total : 0.5;

  const costRank = COST_RANK[worker.costTier ?? "medium"] ?? 0.5;
  const latRank = LAT_RANK[worker.latencyTier ?? "medium"] ?? 0.5;

  const inFlight = ctx.utilization.get(worker.workerId) ?? 0;
  const capacity = worker.concurrencyLimit ?? 4;
  const load = Math.min(1, inFlight / capacity);

  const preference = ctx.preferredWorkerId === worker.workerId ? 1 : 0;
  const underSampled = (outcome?.total ?? 0) < p.explorationSampleFloor ? 1 : 0;

  const score =
    p.wCapability * capability +
    p.wPreferredType * typeMatch +
    p.wHistory * history +
    p.wPreference * preference +
    p.explorationBonus * underSampled -
    p.wCost * costRank * req.costSensitivity -
    p.wLatency * latRank * req.latencySensitivity -
    p.wLoad * load;

  const reason =
    `cap(${req.dimension})=${capability.toFixed(2)} type=${typeMatch} hist=${history.toFixed(2)}` +
    `${preference ? " +pref" : ""}${underSampled ? " +explore" : ""} costSens=${req.costSensitivity}`;
  return { score, reason };
}
