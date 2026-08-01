import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { makeStack, makeTaskDef, tmpPath } from "./helpers.js";
import type { Reviewer } from "../src/domain/review.js";
import type { ReviewResult } from "../src/contract/index.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { force: true });
});

describe("task lifecycle", () => {
  it("round-trips created -> queued -> dispatched -> running -> review -> completed", async () => {
    const { cp, store } = makeStack();
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    expect(store.getTask(taskId)?.state).toBe("queued");

    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    const view = cp.getResult(taskId)!;
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]!.state).toBe("completed");

    // The event log recorded the full path in order.
    const types = store.getEvents(taskId).map((e) => e.type);
    expect(types).toEqual([
      "task.created",
      "task.state", // queued
      "task.state", // dispatched
      "run.dispatching",
      "run.running",
      "task.state", // running
      "run.result",
      "task.state", // review
      "review",
      "task.state", // completed
    ]);
  });

  it("survives a restart: state is queryable from a fresh store on the same file", async () => {
    const dbPath = tmpPath("sqlite");
    cleanup.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`);

    const first = makeStack({ dbPath });
    const taskId = first.cp.dispatchWorker({ definition: makeTaskDef() });
    await first.cp.drain();
    expect(first.store.getTask(taskId)?.state).toBe("completed");
    first.store.close();

    // "Restart": brand-new store + control plane on the same DB file.
    const second = makeStack({ dbPath });
    const view = second.cp.getResult(taskId)!;
    expect(view.task.state).toBe("completed");
    expect(view.runs[0]!.state).toBe("completed");
    second.store.close();
  });

  it("orders dependent tasks: a blocked task waits until its dependency completes", async () => {
    const { cp, store } = makeStack();
    const a = cp.dispatchWorker({ definition: makeTaskDef({ description: "A" }) });
    const b = cp.dispatchWorker({ definition: makeTaskDef({ description: "B", deps: [a] }) });

    // B is not admitted while A is incomplete.
    expect(store.getTask(b)?.state).toBe("created");
    expect(store.getTask(a)?.state).toBe("queued");

    await cp.drain();

    expect(store.getTask(a)?.state).toBe("completed");
    expect(store.getTask(b)?.state).toBe("completed");
  });

  it("revise verdict loops the task back through the queue, then completes", async () => {
    let calls = 0;
    const reviewer: Reviewer = {
      async review(): Promise<ReviewResult> {
        calls += 1;
        return calls === 1
          ? { verdict: "revise", findings: [{ severity: "S1", title: "try again" }] }
          : { verdict: "accept", findings: [] };
      },
    };
    const { cp, store } = makeStack({ reviewer });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(calls).toBe(2);
    expect(store.getTask(taskId)?.state).toBe("completed");
    // Two runs: the first (revised) and the second (accepted).
    expect(cp.getResult(taskId)!.runs).toHaveLength(2);
  });

  it("escalates a dispatch failure immediately (non-retryable) without burning attempts", async () => {
    const { cp, store } = makeStack({
      script: (spec) => (spec.taskType === "boom" ? { dispatch: "fail" } : {}),
      retry: { maxAttempts: 2 },
    });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ taskType: "boom" }) });
    await cp.drain();
    // A dispatch failure is non-retryable (BackendError defaults dispatch_failed
    // so): the orchestrator escalates at once rather than relaunching. Retryable
    // failures that retry-then-escalate are covered in retry.test.ts.
    expect(store.getTask(taskId)?.state).toBe("escalated");
    expect(store.listRunsByTask(taskId).filter((r) => r.state === "errored")).toHaveLength(1);
  });

  it("cancelTask cancels a queued task", async () => {
    const { cp, store } = makeStack();
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    const ok = await cp.cancelTask(taskId, "no longer needed");
    expect(ok).toBe(true);
    expect(store.getTask(taskId)?.state).toBe("cancelled");
  });
});
