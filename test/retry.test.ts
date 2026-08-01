import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { FakeBackend } from "../src/backends/fake/fakeBackend.js";
import type { Backend } from "../src/contract/index.js";
import { makeTaskDef } from "./helpers.js";

/** Fake that fails whichever worker uses model "model-A", succeeds otherwise. */
function backendFailingModelA(): Backend {
  return new FakeBackend({
    script: (spec) => (spec.modelPreference === "model-A" ? { phases: ["errored"] } : {}),
  });
}

describe("retry policy", () => {
  it("switches to an alternate worker on failure and completes", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([
      { workerId: "wA", backend: "fake", model: "model-A", availability: "available", preferredTaskTypes: ["implementation"] },
      { workerId: "wB", backend: "fake", model: "model-B", availability: "available", preferredTaskTypes: ["implementation"] },
      { workerId: "wR", backend: "fake", model: "model-R", availability: "available", preferredTaskTypes: ["review"] },
    ]);
    const cp = new ControlPlane({
      store,
      registry,
      backends: new Map<string, Backend>([["fake", backendFailingModelA()]]),
      dispatch: { pollDelayMs: 0 },
    });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    const implRuns = store.listRunsByTask(taskId).filter((r) => r.runSpec.taskType !== "review");
    expect(implRuns).toHaveLength(2); // wA failed, wB succeeded
    expect(implRuns[0]!.workerId).toBe("wA");
    expect(implRuns[1]!.workerId).toBe("wB"); // switched worker on retry
    store.close();
  });

  it("escalates after exhausting attempts when every worker fails the same way", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([
      { workerId: "wA", backend: "fake", model: "model-A", availability: "available", preferredTaskTypes: ["implementation"] },
      { workerId: "wR", backend: "fake", model: "model-R", availability: "available", preferredTaskTypes: ["review"] },
    ]);
    // Fail every implementation run (any worker); review runs are unaffected.
    const failAllImpl = new FakeBackend({
      script: (spec) => (spec.taskType === "review" ? {} : { phases: ["errored"] }),
    });
    const cp = new ControlPlane({
      store,
      registry,
      backends: new Map<string, Backend>([["fake", failAllImpl]]),
      retry: { maxAttempts: 3 },
      dispatch: { pollDelayMs: 0 },
    });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("escalated");
    // 3 attempts, all on wA (the only implementer), all errored.
    expect(store.listRunsByTask(taskId).filter((r) => r.state === "errored")).toHaveLength(3);
    store.close();
  });
});
