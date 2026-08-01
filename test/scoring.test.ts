import { describe, it, expect } from "vitest";
import { Registry, type WorkerRecord } from "../src/scheduler/registry.js";
import { selectWorker, type SchedulerInputs } from "../src/scheduler/scheduler.js";
import { DEFAULT_POLICY, type WorkerOutcome } from "../src/scheduler/scoring.js";
import { makeTaskDef } from "./helpers.js";

function inputs(workers: WorkerRecord[], outcomes?: Map<string, WorkerOutcome>): SchedulerInputs {
  return {
    registry: new Registry(workers),
    availableBackends: new Set(["fake"]),
    utilization: new Map(),
    outcomes: outcomes ?? new Map(),
    policy: DEFAULT_POLICY,
  };
}

const cheap: WorkerRecord = { workerId: "cheap", backend: "fake", model: "m", costTier: "low", strengths: { coding: 60 } };
const sol: WorkerRecord = { workerId: "sol", backend: "fake", model: "m", costTier: "high", strengths: { coding: 95 } };

describe("capability scoring: cost-tier routing", () => {
  it("sends a trivial (low-effort) task to the cheap worker", () => {
    const d = selectWorker(makeTaskDef({ effort: "low" }), inputs([cheap, sol]));
    expect(d?.worker.workerId).toBe("cheap"); // cost dominates when the task is trivial
  });

  it("sends a hard (xhigh-effort) task to the high-capability worker despite cost", () => {
    const d = selectWorker(makeTaskDef({ effort: "xhigh" }), inputs([cheap, sol]));
    expect(d?.worker.workerId).toBe("sol"); // capability dominates when the task is hard
  });
});

describe("historical-success feedback", () => {
  it("prefers the worker with the better track record when otherwise equal", () => {
    const a: WorkerRecord = { workerId: "a", backend: "fake", model: "m", costTier: "medium", strengths: { coding: 70 } };
    const b: WorkerRecord = { workerId: "b", backend: "fake", model: "m", costTier: "medium", strengths: { coding: 70 } };
    const outcomes = new Map<string, WorkerOutcome>([
      ["a", { total: 10, completed: 2, costUsd: 0 }], // 20% success
      ["b", { total: 10, completed: 9, costUsd: 0 }], // 90% success
    ]);
    expect(selectWorker(makeTaskDef(), inputs([a, b], outcomes))?.worker.workerId).toBe("b");
  });
});

describe("exploration", () => {
  it("gives an under-sampled worker a bonus so it isn't starved by an incumbent", () => {
    const incumbent: WorkerRecord = { workerId: "incumbent", backend: "fake", model: "m", costTier: "medium", strengths: { coding: 70 } };
    const newcomer: WorkerRecord = { workerId: "newcomer", backend: "fake", model: "m", costTier: "medium", strengths: { coding: 70 } };
    const outcomes = new Map<string, WorkerOutcome>([
      ["incumbent", { total: 20, completed: 10, costUsd: 0 }], // sampled, mediocre
      // newcomer has no history -> under-sampled -> exploration bonus
    ]);
    expect(selectWorker(makeTaskDef(), inputs([incumbent, newcomer], outcomes))?.worker.workerId).toBe("newcomer");
  });
});

describe("cost ceiling (hard constraint)", () => {
  it("excludes a worker that has reached its cost ceiling", () => {
    const overBudget: WorkerRecord = { workerId: "over", backend: "fake", model: "m", costCeilingUsd: 10 };
    const under: WorkerRecord = { workerId: "under", backend: "fake", model: "m" };
    const outcomes = new Map<string, WorkerOutcome>([["over", { total: 5, completed: 5, costUsd: 12 }]]);
    expect(selectWorker(makeTaskDef(), inputs([overBudget, under], outcomes))?.worker.workerId).toBe("under");
  });

  it("returns null when the only eligible worker is over budget", () => {
    const overBudget: WorkerRecord = { workerId: "over", backend: "fake", model: "m", costCeilingUsd: 10 };
    const outcomes = new Map<string, WorkerOutcome>([["over", { total: 5, completed: 5, costUsd: 12 }]]);
    expect(selectWorker(makeTaskDef(), inputs([overBudget], outcomes))).toBeNull();
  });
});
