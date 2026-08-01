import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { DaemonRuntime } from "../src/daemon/runtime.js";
import { buildRunSpec } from "../src/dispatcher/dispatcher.js";
import { makeStack, makeTaskDef } from "./helpers.js";

describe("DaemonRuntime", () => {
  it("processes submitted tasks in the background; submit returns immediately", async () => {
    const { cp, store } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();

    const taskId = rt.submit({ definition: makeTaskDef() });
    expect(typeof taskId).toBe("string"); // returned without waiting for completion

    await rt.idle();
    expect(store.getTask(taskId)?.state).toBe("completed");
    await rt.stop();
  });

  it("drains many tasks (including a dependency chain) to completion", async () => {
    const { cp, store } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();

    const a = rt.submit({ definition: makeTaskDef({ description: "A" }) });
    const b = rt.submit({ definition: makeTaskDef({ description: "B", deps: [a] }) });
    rt.submit({ definition: makeTaskDef({ description: "C" }) });

    await rt.idle();
    expect(store.getTask(a)?.state).toBe("completed");
    expect(store.getTask(b)?.state).toBe("completed");
    await rt.stop();
  });

  it("recovers persisted in-flight state on start, then completes it", async () => {
    const { cp, store, registry } = makeStack();
    // Seed a `dispatching` orphan (crash between intent and dispatch), same as reconcile.
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    const task = store.getTask(taskId)!;
    const runId = randomUUID();
    store.setTaskState(taskId, "dispatched", "seed");
    store.recordRunIntent({
      runId,
      taskId,
      workerId: "w1",
      backendId: "fake",
      runSpec: buildRunSpec(task, registry.get("w1")!, runId),
    });

    const rt = new DaemonRuntime(cp);
    const report = await rt.start();
    expect(report.requeued).toBe(1);

    await rt.idle();
    expect(store.getTask(taskId)?.state).toBe("completed");
    await rt.stop();
  });
});
