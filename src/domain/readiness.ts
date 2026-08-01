/**
 * Task-readiness gate. Autonomous execution has no human per run, so an
 * underspecified task is the system's single biggest failure mode. This is the
 * enforcement floor: a task that lacks real acceptance criteria (or, under a
 * stricter policy, an executable verification) is not dispatchable -- it
 * escalates at admission instead of being handed to a worker.
 *
 * This is a floor, not a guarantee: it cannot judge semantic completeness (a
 * task can have a passing-looking check and still be the wrong task). The
 * detection layer -- independent review, cross-worker-failure escalation,
 * revision-rate telemetry -- catches what slips through.
 */

import type { TaskDefinition } from "./model.js";

export interface ReadinessPolicy {
  /** Require a non-empty description. Default true. */
  readonly requireDescription?: boolean;
  /** Require at least one non-empty acceptance criterion. Default true. */
  readonly requireAcceptanceCriteria?: boolean;
  /** Require an executable verification command (the strongest form). Default false. */
  readonly requireExecutableVerification?: boolean;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/** The default floor: a real description + at least one acceptance criterion. */
export const DEFAULT_READINESS: ReadinessPolicy = {
  requireDescription: true,
  requireAcceptanceCriteria: true,
  requireExecutableVerification: false,
};

const nonEmpty = (s: string | undefined): boolean => (s ?? "").trim().length > 0;

export function checkTaskReadiness(def: TaskDefinition, policy: ReadinessPolicy = DEFAULT_READINESS): ReadinessResult {
  const reasons: string[] = [];
  if ((policy.requireDescription ?? true) && !nonEmpty(def.description)) {
    reasons.push("empty description");
  }
  if ((policy.requireAcceptanceCriteria ?? true) && def.acceptanceCriteria.filter(nonEmpty).length === 0) {
    reasons.push("no acceptance criteria a reviewer could apply");
  }
  if ((policy.requireExecutableVerification ?? false) && !nonEmpty(def.verificationCommand)) {
    reasons.push("no executable verification command (policy requires one)");
  }
  return { ready: reasons.length === 0, reasons };
}
