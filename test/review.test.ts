import { describe, it, expect } from "vitest";
import { Registry } from "../src/scheduler/registry.js";
import { selectReviewer } from "../src/scheduler/scheduler.js";
import { LoomStore } from "../src/persistence/store.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { FakeBackend } from "../src/backends/fake/fakeBackend.js";
import type { Backend, ReviewResult } from "../src/contract/index.js";
import type { Reviewer } from "../src/domain/review.js";
import { makeStack, makeTaskDef } from "./helpers.js";

const inputs = (registry: Registry) => ({
  registry,
  availableBackends: new Set(["fake"]),
  utilization: new Map<string, number>(),
});

describe("selectReviewer (the 'Sol for reviews' policy)", () => {
  it("never selects the implementer, and prefers the highest review strength", () => {
    const registry = new Registry([
      { workerId: "impl", backend: "fake", model: "m", strengths: { review: 10 } },
      { workerId: "cheapReviewer", backend: "fake", model: "m", costTier: "low", strengths: { review: 60 } },
      { workerId: "sol", backend: "fake", model: "m", costTier: "high", strengths: { review: 95 } },
    ]);
    const d = selectReviewer(makeTaskDef(), inputs(registry), "impl");
    expect(d?.worker.workerId).toBe("sol"); // highest review strength wins, cost is only a tiebreak
  });

  it("breaks ties on cost (cheaper wins equal review strength)", () => {
    const registry = new Registry([
      { workerId: "impl", backend: "fake", model: "m" },
      { workerId: "pricey", backend: "fake", model: "m", costTier: "high", strengths: { review: 80 } },
      { workerId: "thrifty", backend: "fake", model: "m", costTier: "low", strengths: { review: 80 } },
    ]);
    expect(selectReviewer(makeTaskDef(), inputs(registry), "impl")?.worker.workerId).toBe("thrifty");
  });

  it("returns null when the implementer is the only worker (no self-review)", () => {
    const registry = new Registry([{ workerId: "solo", backend: "fake", model: "m" }]);
    expect(selectReviewer(makeTaskDef(), inputs(registry), "solo")).toBeNull();
  });
});

describe("review outcomes", () => {
  it("bounded revision loop: keeps revising up to the limit, then escalates", async () => {
    const alwaysRevise: Reviewer = {
      async review(): Promise<ReviewResult> {
        return { verdict: "revise", findings: [{ severity: "S1", title: "again" }] };
      },
    };
    const { cp, store } = makeStack({ reviewer: alwaysRevise, retry: { maxRevisions: 2 } });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("escalated");
    // initial run + 2 revision runs = 3 implementer runs before escalation.
    expect(store.listRunsByTask(taskId)).toHaveLength(3);
  });

  it("reject escalates immediately", async () => {
    const reject: Reviewer = {
      async review(): Promise<ReviewResult> {
        return { verdict: "reject", findings: [{ severity: "S0", title: "wrong approach" }] };
      },
    };
    const { cp, store } = makeStack({ reviewer: reject });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("escalated");
    expect(store.listRunsByTask(taskId)).toHaveLength(1);
  });

  it("escalates when there is no independent reviewer (never self-reviews)", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([{ workerId: "solo", backend: "fake", model: "m", availability: "available" }]);
    const cp = new ControlPlane({
      store,
      registry,
      backends: new Map<string, Backend>([["fake", new FakeBackend()]]),
      dispatch: { pollDelayMs: 0 },
    });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("escalated");
    store.close();
  });

  it("reviews via a dispatched review run when the reviewer backend has no native review", async () => {
    const store = new LoomStore(":memory:");
    // Implementer on a native-less backend; reviewer on a backend that returns a verdict deliverable.
    const implBackend = new FakeBackend({ id: "impl-be", capabilities: { supportsNativeReview: false } });
    const reviewerBackend = new FakeBackend({
      id: "rev-be",
      capabilities: { supportsNativeReview: false },
      // On a review-typed run, emit a verdict as a deliverable (the dispatched-review path parses this).
      script: (spec) =>
        spec.taskType === "review"
          ? { result: { deliverables: { verdict: "accept", findings: [] } } }
          : {},
    });
    const registry = new Registry([
      { workerId: "impl", backend: "impl-be", model: "m", availability: "available", preferredTaskTypes: ["implementation"] },
      { workerId: "rev", backend: "rev-be", model: "m", availability: "available", preferredTaskTypes: ["review"] },
    ]);
    const cp = new ControlPlane({
      store,
      registry,
      backends: new Map<string, Backend>([
        ["impl-be", implBackend],
        ["rev-be", reviewerBackend],
      ]),
      dispatch: { pollDelayMs: 0 },
    });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
    // A separate review run was recorded (taskType "review") alongside the implementer run.
    const runs = store.listRunsByTask(taskId);
    expect(runs.some((r) => r.runSpec.taskType === "review")).toBe(true);
    store.close();
  });
});
