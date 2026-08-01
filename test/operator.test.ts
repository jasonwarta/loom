/**
 * Operator-surface fixes: escalation reasons reachable through the Dispatch
 * API, resume_task delivering its addendum, waiting tasks re-queueing, queue
 * priority, drain slot pool, and durable task_meta.
 */
import { describe, it, expect } from "vitest";
import { DaemonRuntime } from "../src/daemon/runtime.js";
import { createTools, type LoomTool } from "../src/mcp/tools.js";
import { LoomStore } from "../src/persistence/store.js";
import { makeStack, makeTaskDef, tmpPath } from "./helpers.js";

function toolMap(rt: DaemonRuntime, repoRoot?: string): Map<string, LoomTool> {
  return new Map(createTools(rt, repoRoot !== undefined ? { repoRoot } : {}).map((t) => [t.name, t]));
}

describe("escalation visibility (Dispatch API)", () => {
  it("get_result carries the event history including the escalation reason", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();
    const tools = toolMap(rt);
    const { taskId } = (await tools.get("dispatch_worker")!.handler({
      description: "vague",
      acceptanceCriteria: [],
      repo: "example.com",
    })) as { taskId: string };
    await rt.idle();

    const result = (await tools.get("get_result")!.handler({ taskId })) as {
      task: { state: string };
      events: Array<{ type: string; data: Record<string, unknown> }>;
    };
    expect(result.task.state).toBe("escalated");
    const esc = result.events.find((e) => e.type === "escalation");
    expect(esc).toBeDefined();
    expect(String(esc!.data["reason"])).toMatch(/acceptance criteria/);
    await rt.stop();
  });

  it("status lists open escalations with reasons, and resume resolves them", async () => {
    let n = 0;
    const { cp, store } = makeStack({
      script: () => (++n === 1 ? { dispatch: "fail" } : {}),
      retry: { maxAttempts: 1 },
    });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("escalated");

    const open = cp.getStatus().openEscalations;
    expect(open).toHaveLength(1);
    expect(open[0]!.taskId).toBe(taskId);
    expect(open[0]!.reason).toMatch(/non-retryable/);

    expect(cp.resumeTask(taskId)).toBe(true);
    expect(cp.getStatus().openEscalations).toHaveLength(0);
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
  });
});

describe("resume_task", () => {
  it("delivers the addendum to the next run's prompt as an operator note (once)", async () => {
    let n = 0;
    const { cp, store } = makeStack({
      script: () => (++n === 1 ? { dispatch: "fail" } : {}),
      retry: { maxAttempts: 1 },
    });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("escalated");

    cp.resumeTask(taskId, "use the blue wire, not the red one");
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
    const runs = store.listRunsByTask(taskId);
    const lastSpec = runs[runs.length - 1]!.runSpec;
    expect(lastSpec.priorReviewFindings).toContain("## Operator note");
    expect(lastSpec.priorReviewFindings).toContain("blue wire");
    // Consumed on dispatch: it must not leak into later runs.
    expect(store.getTaskMeta(taskId, "operatorNote")).toBeUndefined();
  });

  it("re-queues a waiting task instead of stranding it in 'running'", async () => {
    const { cp, store } = makeStack();
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    // Walk the task into `waiting` (a blocked worker) without running a backend.
    store.setTaskState(taskId, "dispatched", "test");
    store.setTaskState(taskId, "running", "test");
    store.setTaskState(taskId, "waiting", "worker blocked");

    expect(cp.resumeTask(taskId, "the answer to your question is 42")).toBe(true);
    expect(store.getTask(taskId)?.state).toBe("queued"); // dispatchable again, not a zombie
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
  });
});

describe("queue priority + drain pool", () => {
  it("dispatches strictly by priority (age breaks ties)", async () => {
    const order: string[] = [];
    const { cp } = makeStack({
      script: (spec) => {
        if (spec.taskType !== "review") order.push(spec.taskId);
        return {};
      },
    });
    const low = cp.dispatchWorker({ definition: makeTaskDef({ priority: 1 }) });
    const high = cp.dispatchWorker({ definition: makeTaskDef({ priority: 9 }) });
    const mid = cp.dispatchWorker({ definition: makeTaskDef({ priority: 5 }) });
    await cp.drain({ concurrency: 1 });
    expect(order).toEqual([high, mid, low]);
  });

  it("retries a deferred task (no eligible worker) once capacity frees, without spinning", async () => {
    // ONE eligible worker with concurrencyLimit 1; two tasks with drain
    // concurrency 2: task B cannot dispatch while A holds the slot (deferred),
    // and must still complete once A finishes. Review is injected so the
    // offline reviewer worker never matters.
    const { cp, store, registry } = makeStack({
      reviewer: { review: async () => ({ verdict: "accept", findings: [] }) },
    });
    registry.upsert({ ...registry.get("w1")!, concurrencyLimit: 1 });
    registry.upsert({ ...registry.get("w-reviewer")!, availability: "offline" });
    const a = cp.dispatchWorker({ definition: makeTaskDef() });
    const b = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain({ concurrency: 2 });
    expect(store.getTask(a)?.state).toBe("completed");
    expect(store.getTask(b)?.state).toBe("completed");
  });
});

describe("durable task_meta", () => {
  it("round-trips and survives a store reopen (restart)", () => {
    const dbPath = tmpPath("sqlite");
    const first = new LoomStore(dbPath);
    first.createTask("t1", makeTaskDef());
    first.setTaskMeta("t1", "revisionNotes", "- [S1] fix it");
    first.setTaskMeta("t1", "reviseBranch", "loom/run-1");
    first.setTaskMeta("t1", "reviseBranch", "loom/run-2"); // upsert
    first.close();

    const second = new LoomStore(dbPath);
    expect(second.getTaskMeta("t1", "revisionNotes")).toBe("- [S1] fix it");
    expect(second.getTaskMeta("t1", "reviseBranch")).toBe("loom/run-2");
    second.deleteTaskMeta("t1", "reviseBranch");
    expect(second.getTaskMeta("t1", "reviseBranch")).toBeUndefined();
    second.close();
  });
});

describe("repo binding (one server per repo)", () => {
  it("defaults repo to the server's repoRoot when omitted", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    await rt.start();
    const tools = toolMap(rt, "/srv/the-repo");
    const { taskId } = (await tools.get("dispatch_worker")!.handler({
      description: "do it",
      acceptanceCriteria: ["done"],
    })) as { taskId: string };
    await rt.idle();
    const result = (await tools.get("get_result")!.handler({ taskId })) as {
      task: { definition: { repo: string } };
    };
    expect(result.task.definition.repo).toBe("/srv/the-repo");
    await rt.stop();
  });

  it("rejects a repo that differs from the bound repoRoot", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    const tools = toolMap(rt, "/srv/the-repo");
    await expect(async () =>
      tools.get("dispatch_worker")!.handler({
        description: "do it",
        acceptanceCriteria: ["done"],
        repo: "/somewhere/else",
      }),
    ).rejects.toThrow(/bound to repo/);
    await rt.stop();
  });

  it("still requires repo when the server has no bound repoRoot", async () => {
    const { cp } = makeStack();
    const rt = new DaemonRuntime(cp);
    const tools = toolMap(rt);
    await expect(async () =>
      tools.get("dispatch_worker")!.handler({ description: "do it", acceptanceCriteria: ["done"] }),
    ).rejects.toThrow(/repo/);
    await rt.stop();
  });
});
