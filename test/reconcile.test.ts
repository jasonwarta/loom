import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { makeStack, makeTaskDef, tmpPath } from "./helpers.js";
import { buildRunSpec } from "../src/dispatcher/dispatcher.js";
import { randomUUID } from "node:crypto";

/**
 * These tests exercise crash recovery at the exact write-ahead / side-effect
 * boundary (IMPLEMENTATION-PLAN M0 acceptance). Rather than racing a real
 * process kill (non-deterministic), they reproduce each precise interleaving
 * by driving the store + backend to the crash point, closing the store, then
 * rebuilding a fresh control plane on the SAME sqlite file (a real restart) and
 * running recover(). The DB genuinely persists across the close/reopen.
 */

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { force: true });
});

function paths() {
  const dbPath = tmpPath("sqlite");
  const journalPath = tmpPath("json");
  cleanup.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`, journalPath);
  return { dbPath, journalPath };
}

describe("restart reconciliation", () => {
  it("crash BETWEEN write-ahead intent and dispatch -> orphan is re-queued and completes", async () => {
    const { dbPath, journalPath } = paths();
    const s1 = makeStack({ dbPath, journalPath });
    const taskId = s1.cp.dispatchWorker({ definition: makeTaskDef() });

    // Simulate processTask up to the crash point: intent written, backend NOT called.
    const task = s1.store.getTask(taskId)!;
    const worker = s1.registry.get("w1")!;
    const runId = randomUUID();
    s1.store.setTaskState(taskId, "dispatched", "test");
    s1.store.recordRunIntent({
      runId,
      taskId,
      workerId: "w1",
      backendId: "fake",
      runSpec: buildRunSpec(task, worker, runId),
    });
    // CRASH: backend.dispatch never ran, so the journal has no such run.
    s1.store.close();

    const s2 = makeStack({ dbPath, journalPath });
    const report = await s2.cp.recover();
    expect(report.requeued).toBe(1);
    expect(report.adopted).toBe(0);
    // The orphan run is errored; the task is re-queued.
    expect(s2.store.getRun(runId)?.state).toBe("errored");

    await s2.cp.drain();
    expect(s2.store.getTask(taskId)?.state).toBe("completed");
    // Exactly one NEW successful run beyond the errored orphan.
    const runs = s2.store.listRunsByTask(taskId);
    expect(runs.filter((r) => r.state === "completed")).toHaveLength(1);
    s2.store.close();
  });

  it("crash BETWEEN dispatch and handle-backfill -> orphan is adopted, not re-run", async () => {
    const { dbPath, journalPath } = paths();
    const s1 = makeStack({ dbPath, journalPath });
    const taskId = s1.cp.dispatchWorker({ definition: makeTaskDef() });

    const task = s1.store.getTask(taskId)!;
    const worker = s1.registry.get("w1")!;
    const runId = randomUUID();
    const spec = buildRunSpec(task, worker, runId);
    s1.store.setTaskState(taskId, "dispatched", "test");
    s1.store.recordRunIntent({ runId, taskId, workerId: "w1", backendId: "fake", runSpec: spec });
    // The backend DID start the run (journal now has it) ...
    await s1.backend.dispatch(spec);
    // ... but we CRASH before attachRunHandle.
    s1.store.close();

    const s2 = makeStack({ dbPath, journalPath });
    const report = await s2.cp.recover();
    expect(report.adopted).toBe(1);
    expect(report.requeued).toBe(0);

    // Exactly ONE run for the task -- adopted and completed, never double-run.
    const runs = s2.store.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(runId);
    expect(runs[0]!.state).toBe("completed");
    expect(s2.store.getTask(taskId)?.state).toBe("completed");
    s2.store.close();
  });

  it("crash mid-await on a durable backend -> run is resumed to completion", async () => {
    const { dbPath, journalPath } = paths();
    const s1 = makeStack({ dbPath, journalPath });
    const taskId = s1.cp.dispatchWorker({ definition: makeTaskDef() });

    const task = s1.store.getTask(taskId)!;
    const worker = s1.registry.get("w1")!;
    const runId = randomUUID();
    const spec = buildRunSpec(task, worker, runId);
    s1.store.setTaskState(taskId, "dispatched", "test");
    s1.store.recordRunIntent({ runId, taskId, workerId: "w1", backendId: "fake", runSpec: spec });
    const handle = await s1.backend.dispatch(spec);
    s1.store.attachRunHandle(runId, handle.native); // run is now "running"
    s1.store.setTaskState(taskId, "running", "test");
    // CRASH mid-await (before the result was fetched).
    s1.store.close();

    const s2 = makeStack({ dbPath, journalPath });
    await s2.cp.recover();
    expect(s2.store.getTask(taskId)?.state).toBe("completed");
    expect(s2.store.listRunsByTask(taskId)).toHaveLength(1);
    s2.store.close();
  });

  it("running run on a NON-durable backend is re-queued as a fresh run", async () => {
    // No journalPath -> in-memory fake -> crossRestartRecoverable=false.
    const dbPath = tmpPath("sqlite");
    cleanup.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`);

    const s1 = makeStack({ dbPath });
    const taskId = s1.cp.dispatchWorker({ definition: makeTaskDef() });
    const task = s1.store.getTask(taskId)!;
    const worker = s1.registry.get("w1")!;
    const runId = randomUUID();
    const spec = buildRunSpec(task, worker, runId);
    s1.store.setTaskState(taskId, "dispatched", "test");
    s1.store.recordRunIntent({ runId, taskId, workerId: "w1", backendId: "fake", runSpec: spec });
    const handle = await s1.backend.dispatch(spec);
    s1.store.attachRunHandle(runId, handle.native);
    s1.store.setTaskState(taskId, "running", "test");
    s1.store.close();

    // Restart with a brand-new (empty) in-memory backend: the old run is gone.
    const s2 = makeStack({ dbPath });
    const report = await s2.cp.recover();
    expect(report.requeued).toBe(1);
    expect(s2.store.getRun(runId)?.state).toBe("errored");

    await s2.cp.drain();
    expect(s2.store.getTask(taskId)?.state).toBe("completed");
    s2.store.close();
  });
});
