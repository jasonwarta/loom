/**
 * LoomStore -- durable, event-sourced state on SQLite (ARCHITECTURE section 15).
 *
 * Two guarantees:
 *  - Every state transition appends to the append-only `task_event` log AND
 *    updates its projection row in the SAME transaction, so the projection
 *    tables are always consistent with the log and survive a restart.
 *  - Dispatch uses a transactional-outbox: `recordRunIntent` writes a
 *    `dispatching` run row BEFORE the external backend call; `attachRunHandle`
 *    backfills the native handle AFTER. A crash between the two leaves a
 *    discoverable orphan (run in state `dispatching`, native_handle NULL) that
 *    reconciliation resolves -- never a lost or double-run run.
 */

import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import {
  TERMINAL_RUN_STATES,
  type RunRecord,
  type RunState,
  type StoredRunResult,
  type TaskDefinition,
  type TaskEvent,
  type TaskRecord,
  type TaskState,
} from "../domain/model.js";
import type { ReviewResult, RunResult, RunSpec } from "../contract/index.js";

interface TaskRow {
  id: string;
  definition: string;
  state: string;
  created_at: number;
  updated_at: number;
}
interface RunRow {
  run_id: string;
  task_id: string;
  worker_id: string;
  backend_id: string;
  run_spec: string;
  native_handle: string | null;
  state: string;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}
interface ResultRow {
  run_id: string;
  result: string;
  stored_at: number;
}
interface EventRow {
  seq: number;
  task_id: string;
  at: number;
  type: string;
  data: string;
}

export interface StatusSummary {
  readonly tasksByState: Record<string, number>;
  readonly runsByState: Record<string, number>;
  readonly runsByWorker: Record<string, number>;
  readonly reviewsByVerdict: Record<string, number>;
  readonly escalations: number;
  readonly totalCostUsd: number;
}

export class LoomStore {
  private readonly db: Database.Database;
  /** Injectable clock for deterministic tests. */
  now: () => number = () => Date.now();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn in a single synchronous transaction. */
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private appendEvent(taskId: string, type: string, data: Record<string, unknown>, at: number): void {
    this.db
      .prepare("INSERT INTO task_event (task_id, at, type, data) VALUES (?, ?, ?, ?)")
      .run(taskId, at, type, JSON.stringify(data));
  }

  // --- tasks ---

  createTask(id: string, definition: TaskDefinition): TaskRecord {
    const at = this.now();
    return this.tx(() => {
      this.db
        .prepare("INSERT INTO task (id, definition, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, JSON.stringify(definition), "created", at, at);
      this.appendEvent(id, "task.created", { definition }, at);
      return { id, definition, state: "created" as TaskState, createdAt: at, updatedAt: at };
    });
  }

  setTaskState(taskId: string, state: TaskState, reason?: string): void {
    const at = this.now();
    this.tx(() => {
      const info = this.db
        .prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, at, taskId);
      if (info.changes === 0) throw new Error(`setTaskState: no task ${taskId}`);
      this.appendEvent(taskId, "task.state", reason === undefined ? { state } : { state, reason }, at);
    });
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM task WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? this.taskFromRow(row) : undefined;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM task ORDER BY created_at ASC").all() as TaskRow[];
    return rows.map((r) => this.taskFromRow(r));
  }

  listTasksByState(state: TaskState): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM task WHERE state = ? ORDER BY created_at ASC")
      .all(state) as TaskRow[];
    return rows.map((r) => this.taskFromRow(r));
  }

  // --- runs (transactional outbox) ---

  /** Step 1 of dispatch: persist the intent BEFORE calling the backend. */
  recordRunIntent(args: {
    runId: string;
    taskId: string;
    workerId: string;
    backendId: string;
    runSpec: RunSpec;
  }): void {
    const at = this.now();
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO run (run_id, task_id, worker_id, backend_id, run_spec, native_handle, state, created_at) " +
            "VALUES (?, ?, ?, ?, ?, NULL, 'dispatching', ?)",
        )
        .run(args.runId, args.taskId, args.workerId, args.backendId, JSON.stringify(args.runSpec), at);
      this.appendEvent(args.taskId, "run.dispatching", { runId: args.runId, workerId: args.workerId }, at);
    });
  }

  /** Step 2 of dispatch: backfill the captured native handle AFTER the backend returned it. */
  attachRunHandle(runId: string, native: Record<string, string>): void {
    const at = this.now();
    this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`attachRunHandle: no run ${runId}`);
      this.db
        .prepare("UPDATE run SET native_handle = ?, state = 'running', started_at = ? WHERE run_id = ?")
        .run(JSON.stringify(native), at, runId);
      this.appendEvent(run.taskId, "run.running", { runId, native }, at);
    });
  }

  setRunState(runId: string, state: RunState): void {
    const at = this.now();
    this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`setRunState: no run ${runId}`);
      const ended = TERMINAL_RUN_STATES.has(state) ? at : null;
      this.db.prepare("UPDATE run SET state = ?, ended_at = ? WHERE run_id = ?").run(state, ended, runId);
      this.appendEvent(run.taskId, "run.state", { runId, state }, at);
    });
  }

  recordRunResult(runId: string, result: RunResult): void {
    const at = this.now();
    this.tx(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`recordRunResult: no run ${runId}`);
      this.db
        .prepare("INSERT OR REPLACE INTO run_result (run_id, result, stored_at) VALUES (?, ?, ?)")
        .run(runId, JSON.stringify(result), at);
      const runState = resultStatusToRunState(result.status);
      const ended = TERMINAL_RUN_STATES.has(runState) ? at : null;
      this.db.prepare("UPDATE run SET state = ?, ended_at = ? WHERE run_id = ?").run(runState, ended, runId);
      this.appendEvent(run.taskId, "run.result", { runId, status: result.status }, at);
    });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM run WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listRunsByState(state: RunState): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM run WHERE state = ?").all(state) as RunRow[];
    return rows.map((r) => this.runFromRow(r));
  }

  listRunsByTask(taskId: string): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as RunRow[];
    return rows.map((r) => this.runFromRow(r));
  }

  getResult(runId: string): StoredRunResult | undefined {
    const row = this.db.prepare("SELECT * FROM run_result WHERE run_id = ?").get(runId) as
      | ResultRow
      | undefined;
    if (!row) return undefined;
    return { ...(JSON.parse(row.result) as RunResult), storedAt: row.stored_at };
  }

  // --- reviews / escalations / metrics / events ---

  recordReview(id: string, taskId: string, runId: string, reviewerWorkerId: string | null, review: ReviewResult): void {
    const at = this.now();
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO review (id, task_id, run_id, reviewer_worker_id, verdict, findings, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, taskId, runId, reviewerWorkerId, review.verdict, JSON.stringify(review.findings), at);
      this.appendEvent(taskId, "review", { runId, verdict: review.verdict }, at);
    });
  }

  recordEscalation(id: string, taskId: string, reason: string, raisedTo: string): void {
    const at = this.now();
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO escalation (id, task_id, reason, raised_to, status, at) VALUES (?, ?, ?, ?, 'open', ?)",
        )
        .run(id, taskId, reason, raisedTo, at);
      this.appendEvent(taskId, "escalation", { reason, raisedTo }, at);
    });
  }

  /** Open escalations with their reasons -- the operator-facing view (Dispatch API `status`). */
  listOpenEscalations(): Array<{ id: string; taskId: string; reason: string; raisedTo: string; at: number }> {
    const rows = this.db
      .prepare("SELECT id, task_id, reason, raised_to, at FROM escalation WHERE status = 'open' ORDER BY at ASC")
      .all() as Array<{ id: string; task_id: string; reason: string; raised_to: string; at: number }>;
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, reason: r.reason, raisedTo: r.raised_to, at: r.at }));
  }

  /** Mark a task's open escalations resolved (e.g. the operator resumed the task). */
  resolveEscalations(taskId: string, resolution: string): void {
    const at = this.now();
    this.tx(() => {
      const info = this.db
        .prepare("UPDATE escalation SET status = 'resolved', resolution = ? WHERE task_id = ? AND status = 'open'")
        .run(resolution, taskId);
      if (info.changes > 0) this.appendEvent(taskId, "escalation.resolved", { resolution }, at);
    });
  }

  // --- task meta (durable per-task operator/retry state) ---

  setTaskMeta(taskId: string, key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO task_meta (task_id, key, value, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(task_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(taskId, key, value, this.now());
  }

  getTaskMeta(taskId: string, key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM task_meta WHERE task_id = ? AND key = ?")
      .get(taskId, key) as { value: string } | undefined;
    return row?.value;
  }

  deleteTaskMeta(taskId: string, key: string): void {
    this.db.prepare("DELETE FROM task_meta WHERE task_id = ? AND key = ?").run(taskId, key);
  }

  recordMetric(name: string, value: number, labels?: Record<string, string>): void {
    this.db
      .prepare("INSERT INTO metric (at, name, value, labels) VALUES (?, ?, ?, ?)")
      .run(this.now(), name, value, labels ? JSON.stringify(labels) : null);
  }

  /** Aggregate operational snapshot, derived from the tables (always consistent). */
  status(): StatusSummary {
    const group = (sql: string): Record<string, number> => {
      const rows = this.db.prepare(sql).all() as Array<{ k: string | null; n: number }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.k ?? "unknown"] = r.n;
      return out;
    };
    const scalar = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;

    let totalCostUsd = 0;
    for (const row of this.db.prepare("SELECT result FROM run_result").all() as Array<{ result: string }>) {
      const cost = (JSON.parse(row.result) as RunResult).usage?.costUsd;
      if (typeof cost === "number") totalCostUsd += cost;
    }

    return {
      tasksByState: group("SELECT state k, count(*) n FROM task GROUP BY state"),
      runsByState: group("SELECT state k, count(*) n FROM run GROUP BY state"),
      runsByWorker: group("SELECT worker_id k, count(*) n FROM run GROUP BY worker_id"),
      reviewsByVerdict: group("SELECT verdict k, count(*) n FROM review GROUP BY verdict"),
      escalations: scalar("SELECT count(*) n FROM escalation"),
      totalCostUsd,
    };
  }

  /** Per-worker accumulated outcomes: run counts + cost. Feeds capability scheduling (M4). */
  workerOutcomes(): Map<string, { total: number; completed: number; costUsd: number }> {
    const out = new Map<string, { total: number; completed: number; costUsd: number }>();
    const rows = this.db
      .prepare(
        "SELECT worker_id wid, count(*) total, sum(CASE WHEN state='completed' THEN 1 ELSE 0 END) completed FROM run GROUP BY worker_id",
      )
      .all() as Array<{ wid: string; total: number; completed: number }>;
    for (const r of rows) out.set(r.wid, { total: r.total, completed: r.completed, costUsd: 0 });

    const costRows = this.db
      .prepare("SELECT r.worker_id wid, rr.result res FROM run_result rr JOIN run r ON r.run_id = rr.run_id")
      .all() as Array<{ wid: string; res: string }>;
    for (const cr of costRows) {
      const cost = (JSON.parse(cr.res) as RunResult).usage?.costUsd;
      if (typeof cost !== "number") continue;
      const e = out.get(cr.wid) ?? { total: 0, completed: 0, costUsd: 0 };
      out.set(cr.wid, { ...e, costUsd: e.costUsd + cost });
    }
    return out;
  }

  getEvents(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_event WHERE task_id = ? ORDER BY seq ASC")
      .all(taskId) as EventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      taskId: r.task_id,
      at: r.at,
      type: r.type,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  // --- row mappers ---

  private taskFromRow(row: TaskRow): TaskRecord {
    return {
      id: row.id,
      definition: JSON.parse(row.definition) as TaskDefinition,
      state: row.state as TaskState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private runFromRow(row: RunRow): RunRecord {
    return {
      runId: row.run_id,
      taskId: row.task_id,
      workerId: row.worker_id,
      backendId: row.backend_id,
      runSpec: JSON.parse(row.run_spec) as RunSpec,
      nativeHandle: row.native_handle ? (JSON.parse(row.native_handle) as Record<string, string>) : null,
      state: row.state as RunState,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      createdAt: row.created_at,
    };
  }
}

function resultStatusToRunState(status: RunResult["status"]): RunState {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "blocked":
      return "waiting";
  }
}
