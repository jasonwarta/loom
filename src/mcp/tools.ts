/**
 * The Dispatch API (ARCHITECTURE section 10) as a transport-independent set of
 * tool handlers. The MCP server (./server.ts) wraps these; tests exercise them
 * directly. This is the operator's entire interface to the platform --
 * it speaks engineering intent, never a backend command.
 */

import { resolve } from "node:path";
import type { DaemonRuntime } from "../daemon/runtime.js";
import type { Effort } from "../contract/types.js";
import type { TaskDefinition } from "../domain/model.js";

export interface CreateToolsOptions {
  /**
   * The repo this server is bound to (worktrees, context files, and delivery
   * all operate on it). When set, dispatch_worker's `repo` becomes optional
   * (defaulting to it) and a MISMATCHED repo is rejected loudly -- silently
   * running a task against the wrong repo is the worst possible outcome.
   */
  readonly repoRoot?: string;
}

export interface LoomTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool arguments (MCP inputSchema). */
  readonly inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<unknown> | unknown;
}

// --- arg coercion helpers ---
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function reqStr(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`missing required string arg: ${name}`);
  return v;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Resolve + validate the task's repo against the server's bound repo (see CreateToolsOptions). */
function resolveRepo(args: Record<string, unknown>, repoRoot: string | undefined): string {
  const given = str(args["repo"]);
  if (repoRoot === undefined) return reqStr(args["repo"], "repo");
  if (given === undefined || given.trim().length === 0) return repoRoot;
  if (resolve(given) !== resolve(repoRoot)) {
    throw new Error(
      `this Loom server is bound to repo ${repoRoot} (set at serve time); ` +
        `it cannot run tasks against ${given}. Omit \`repo\` or start a separate ` +
        `\`loom serve --repo ${given}\` for that repository.`,
    );
  }
  return repoRoot;
}

function toTaskDefinition(args: Record<string, unknown>, opts: CreateToolsOptions): TaskDefinition {
  const verify = str(args["verificationCommand"]);
  const wall = num(args["wallClockMs"]);
  const ctxFiles = strArr(args["contextFiles"]);
  const resumeFromBranch = str(args["resumeFromBranch"]);
  return {
    taskType: str(args["taskType"]) ?? "implementation",
    description: reqStr(args["description"], "description"),
    acceptanceCriteria: strArr(args["acceptanceCriteria"]),
    priority: num(args["priority"]) ?? 1,
    effort: (str(args["effort"]) as Effort | undefined) ?? "medium",
    repo: resolveRepo(args, opts.repoRoot),
    baseBranch: str(args["baseBranch"]) ?? "main",
    deps: strArr(args["deps"]),
    requiresIndependentReview: args["requiresIndependentReview"] !== false,
    ...(verify ? { verificationCommand: verify } : {}),
    ...(wall !== undefined ? { wallClockMs: wall } : {}),
    ...(ctxFiles.length > 0 ? { contextFiles: ctxFiles } : {}),
    ...(resumeFromBranch ? { resumeFromBranch } : {}),
  };
}

export function createTools(rt: DaemonRuntime, opts: CreateToolsOptions = {}): LoomTool[] {
  const cp = rt.controlPlane;
  return [
    {
      name: "dispatch_worker",
      description:
        "Submit an engineering task for scheduling + execution. Returns a taskId immediately; the platform runs it in the background (poll with query_queue / get_result). Acceptance criteria are required (the readiness gate rejects tasks without them). Provide a verificationCommand wherever possible: the platform executes it in the run's worktree before review, and a failure objectively re-queues the work.",
      inputSchema: {
        type: "object",
        required: ["description", "acceptanceCriteria"],
        properties: {
          description: { type: "string", description: "What the task must accomplish." },
          acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Checkable conditions for acceptance (ideally executable)." },
          repo: {
            type: "string",
            description:
              "Repository path the task operates on. Optional: defaults to the repo this server was started with (--repo); a different repo is rejected (one server per repo).",
          },
          taskType: { type: "string", description: "Open tag, e.g. implementation | review | investigation." },
          baseBranch: { type: "string" },
          effort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh"] },
          priority: { type: "number" },
          deps: { type: "array", items: { type: "string" }, description: "taskIds that must complete first." },
          requiresIndependentReview: { type: "boolean" },
          verificationCommand: { type: "string", description: "Executable check that objectively verifies done." },
          wallClockMs: { type: "number" },
          resumeFromBranch: {
            type: "string",
            description:
              "Recovery mode: an EXISTING branch holding prior, possibly-unpushed work to continue, instead of branching fresh from baseBranch. The worker's workspace is checked out on it and the worker is told to assess and continue that work. Use to resume an earlier run's undelivered work, or to build on an in-flight PR's branch rather than colliding with it.",
          },
          preferredWorkerId: { type: "string", description: "A hint; the scheduler may override it." },
        },
      },
      handler: (args) => {
        const definition = toTaskDefinition(args, opts);
        const preferredWorkerId = str(args["preferredWorkerId"]);
        const taskId = rt.submit(preferredWorkerId ? { definition, preferredWorkerId } : { definition });
        return { taskId };
      },
    },
    {
      name: "query_queue",
      description: "List tasks and per-state counts. The platform is the source of truth; reconstruct state from here after any gap.",
      inputSchema: { type: "object", properties: {} },
      handler: () => cp.queryQueue(),
    },
    {
      name: "query_registry",
      description: "List available workers and their capability profiles.",
      inputSchema: { type: "object", properties: {} },
      handler: () => cp.queryRegistry(),
    },
    {
      name: "inspect_worker",
      description: "Detail on one worker, including live in-flight run count.",
      inputSchema: { type: "object", required: ["workerId"], properties: { workerId: { type: "string" } } },
      handler: (args) => cp.inspectWorker(reqStr(args["workerId"], "workerId")),
    },
    {
      name: "get_result",
      description:
        "Fetch a task's runs, results, current state, and full event history -- including state-transition reasons, review verdicts, and escalation reasons (read `events` to learn WHY a task is escalated or failed).",
      inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
      handler: (args) => cp.getResult(reqStr(args["taskId"], "taskId")),
    },
    {
      name: "cancel_task",
      description: "Cancel a non-terminal task and its in-flight run.",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: { taskId: { type: "string" }, reason: { type: "string" } },
      },
      handler: async (args) => ({
        cancelled: await cp.cancelTask(reqStr(args["taskId"], "taskId"), str(args["reason"]) ?? "operator cancelled"),
      }),
    },
    {
      name: "resume_task",
      description:
        "Re-queue a waiting/failed/escalated task. The addendum (if given) is delivered to the next run's prompt as an operator note -- use it to answer a blocked worker's question or steer the retry. Resuming resolves the task's open escalations.",
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: { taskId: { type: "string" }, addendum: { type: "string" } },
      },
      handler: (args) => {
        const ok = cp.resumeTask(reqStr(args["taskId"], "taskId"), str(args["addendum"]));
        rt.kick();
        return { resumed: ok };
      },
    },
    {
      name: "status",
      description:
        "Operational snapshot: tasks/runs by state, per-worker utilization, review verdicts, open escalations (with reasons), and total cost. Note: cost covers only cost-reporting backends; treat totalCostUsd as a floor, not the whole spend.",
      inputSchema: { type: "object", properties: {} },
      handler: () => cp.getStatus(),
    },
  ];
}
