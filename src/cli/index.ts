#!/usr/bin/env node
/**
 * Loom CLI -- the human/break-glass surface (ARCHITECTURE section 18).
 *
 *   loom demo                        Run a demo epic through the fake backend.
 *   loom run --registry r.yaml \     Run a REAL task through the live backends,
 *     --repo . --task "..." \        in an isolated worktree, with independent
 *     --criteria "a;b"               review.
 *
 * The MCP transport for the operator is a later milestone; this CLI is
 * a thin driver over the control plane.
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDashboardDemoLoom, createDemoLoom, createLiveLoom, createObserveLoom } from "../daemon/index.js";
import { DaemonRuntime } from "../daemon/runtime.js";
import { serveMcp } from "../mcp/server.js";
import { startDashboard } from "../ui/httpServer.js";
import type { TaskDefinition } from "../domain/model.js";

const USAGE = `loom -- orchestration control plane

Usage:
  loom demo
      Run a 3-task demo epic through the in-memory fake backend (no cost).

  loom run --registry <file.yaml> --task "<description>" --criteria "<c1;c2>"
           [--repo <path>] [--type <taskType>] [--worker <workerId>]
           [--verify "<command>"] [--poll <ms>] [--resume-from-branch <branch>]
           [--no-delivery] [--pr-ready] [--pr-remote <name>]
      Run ONE real task through the live backends (Codex/Claude per the
      registry), in an isolated git worktree, with independent review.
      --criteria is required (the readiness gate rejects tasks without it).
      --resume-from-branch continues prior work on an existing branch instead
      of branching fresh from the base (recovery mode).

  loom serve --registry <file.yaml> [--repo <path>] [--poll <ms>] [--ui-port <n>]
             [--no-delivery] [--pr-ready] [--pr-remote <name>]
      Run Loom as a long-lived MCP server over stdio, so an operator
      drives it through the Dispatch API tools. Recovers state on start and
      processes the queue continuously. On review-accept the platform pushes
      the branch and opens a DRAFT PR by default; --no-delivery leaves work on
      its branch, --pr-ready opens non-draft PRs, --pr-remote sets the remote.
      --ui-port also serves the read-only kanban dashboard on that port
      (localhost) over the same daemon.

  loom ui [--port <n>] [--poll <ms>]
      Open a self-contained, zero-cost demo of the read-only kanban dashboard
      (fake backend, no provider): a small epic streams through the board's
      columns in your browser. Default port 4319. Ctrl-C to stop.

  loom view --repo <path> [--db <file>] [--registry <file.yaml>] [--port <n>]
      Mount the read-only dashboard over an EXISTING store to observe a past or
      in-flight run -- WITHOUT starting the daemon (no recover, no dispatch, so
      it can never re-run work). Reads a temp SNAPSHOT copy of the store, so the
      real .loom.sqlite is never touched. --db overrides the default
      <repo>/.loom.sqlite; --registry (default <repo>/registry.yaml) supplies
      worker display names. Default port 4319. Ctrl-C to stop.

  loom help`;

/** Default dashboard port, shared by `serve --ui-port`, `ui`, and `view`. */
const DEFAULT_UI_PORT = 4319;

async function runView(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      db: { type: "string" },
      registry: { type: "string" },
      port: { type: "string" },
    },
  });
  const port = values.port ? Number(values.port) : DEFAULT_UI_PORT;
  const repoRoot = values.repo;
  const dbSource = values.db ?? (repoRoot ? join(repoRoot, ".loom.sqlite") : undefined);
  if (!dbSource) {
    console.error("view: --repo <path> (or --db <file>) is required.");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbSource)) {
    console.error(`view: store not found: ${dbSource}\n(nothing has run against this repo yet?)`);
    process.exitCode = 1;
    return;
  }

  // Snapshot the store (+ WAL/SHM sidecars) into a temp dir, so observing a real
  // run cannot mutate it. Opening the copy read-write is harmless -- schema-ensure
  // and WAL checkpoint touch only the copy, and copying the -wal captures data not
  // yet checkpointed into the main file.
  const tmpDir = mkdtempSync(join(tmpdir(), "loom-view-"));
  const dbCopy = join(tmpDir, "snapshot.sqlite");
  copyFileSync(dbSource, dbCopy);
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(dbSource + ext)) copyFileSync(dbSource + ext, dbCopy + ext);
  }

  const registryPath =
    values.registry ??
    (repoRoot && existsSync(join(repoRoot, "registry.yaml")) ? join(repoRoot, "registry.yaml") : undefined);

  const loom = createObserveLoom(dbCopy, registryPath);
  // Deliberately NOT started: the dashboard uses only read verbs, so there is no
  // recover(), no drain(), no dispatch -- observing a store can never run work.
  const rt = new DaemonRuntime(loom.controlPlane);
  const dash = await startDashboard(rt, { port });
  console.log(`loom: observe-only dashboard at ${dash.url}`);
  console.log(`      snapshot of ${dbSource} -- daemon NOT started, nothing will run. Ctrl-C to stop.`);

  const shutdown = () => {
    void rt.stop().then(async () => {
      await dash.close();
      loom.close();
      rmSync(tmpDir, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runUi(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, poll: { type: "string" } },
  });
  const port = values.port ? Number(values.port) : DEFAULT_UI_PORT;

  const loom = createDashboardDemoLoom(":memory:", values.poll ? Number(values.poll) : 400);
  const rt = new DaemonRuntime(loom.controlPlane);
  await rt.start();

  // Seed an initial epic, then trickle new tasks so the board always has work
  // in flight to watch move across the columns.
  seedDemoEpic(rt);
  let n = 0;
  const trickle = setInterval(() => {
    if (n++ >= 40) return; // bounded; the demo is a viewer, not a load test
    rt.submit({ definition: demoDef(`Task ${n}: ${DEMO_TITLES[n % DEMO_TITLES.length]}`) });
  }, 4000);

  const dash = await startDashboard(rt, { port });
  console.log(`loom: demo dashboard live at ${dash.url}`);
  console.log("      (fake backend, in-memory, no cost) -- Ctrl-C to stop.");

  const shutdown = () => {
    clearInterval(trickle);
    void rt.stop().then(async () => {
      await dash.close();
      loom.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const DEMO_TITLES = [
  "add rate limiting to the API",
  "fix flaky auth test",
  "extract the payments module",
  "wire up the metrics dashboard",
  "migrate config to YAML",
  "cache the registry lookups",
];

/** Submit a small dependency-linked epic to the demo daemon. */
function seedDemoEpic(rt: DaemonRuntime): void {
  const a = rt.submit({ definition: demoDef("Build module A") });
  const b = rt.submit({ definition: demoDef("Build module B") });
  rt.submit({ definition: demoDef("Integrate A + B", [a, b]) });
  rt.submit({ definition: { ...demoDef("Investigate slow startup"), taskType: "investigation" } });
}

async function runServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      registry: { type: "string" },
      repo: { type: "string" },
      poll: { type: "string" },
      "ui-port": { type: "string" },
      "no-delivery": { type: "boolean" },
      "pr-ready": { type: "boolean" },
      "pr-remote": { type: "string" },
    },
  });
  if (!values.registry) {
    console.error("serve: --registry <file.yaml> is required.");
    process.exitCode = 1;
    return;
  }
  const repoRoot = values.repo ?? process.cwd();
  // Fail with a CLEAR message before touching MCP -- a crash here otherwise
  // surfaces to the client only as an opaque "failed to connect".
  if (!existsSync(values.registry)) {
    console.error(
      `serve: registry file not found: ${values.registry}\n` +
        `Create it (a starter 'registry.yaml' ships in the loom repo root).`,
    );
    process.exitCode = 1;
    return;
  }
  if (!existsSync(repoRoot)) {
    console.error(`serve: --repo path not found: ${repoRoot}`);
    process.exitCode = 1;
    return;
  }

  let loom: ReturnType<typeof createLiveLoom>;
  let rt: DaemonRuntime;
  try {
    loom = createLiveLoom({
      dbPath: join(repoRoot, ".loom.sqlite"),
      registryPath: values.registry,
      repoRoot,
      ...(values.poll ? { dispatch: { pollDelayMs: Number(values.poll) } } : {}),
      ...deliveryConfig(values),
    });
    rt = new DaemonRuntime(loom.controlPlane);
  } catch (err) {
    console.error(`serve: failed to start Loom (bad registry or repo?): ${String(err)}`);
    process.exitCode = 1;
    return;
  }
  const report = await rt.start();
  process.stderr.write(`loom: recovered (adopted=${report.adopted} requeued=${report.requeued} ingested=${report.ingested})\n`);

  // Optional read-only dashboard over the SAME daemon. stdout is the MCP
  // channel here, so its startup line goes to stderr.
  let dash: Awaited<ReturnType<typeof startDashboard>> | undefined;
  if (values["ui-port"] !== undefined) {
    dash = await startDashboard(rt, { port: Number(values["ui-port"]) });
    process.stderr.write(`loom: read-only dashboard at ${dash.url}\n`);
  }

  const shutdown = () => {
    void rt.stop().then(async () => {
      if (dash) await dash.close();
      loom.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await serveMcp(rt, { repoRoot });
}

function parseCriteria(s: string | undefined): string[] {
  return (s ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Build createLiveLoom's optional `delivery` config from CLI flags. Delivery is
 * ON by default; `--no-delivery` disables it (leave accepted work on its branch),
 * `--pr-ready` opens non-draft PRs, `--pr-remote` overrides the push remote.
 */
function deliveryConfig(values: {
  "no-delivery"?: boolean;
  "pr-ready"?: boolean;
  "pr-remote"?: string;
}): { delivery?: { enabled?: boolean; draft?: boolean; remote?: string } } {
  if (!values["no-delivery"] && !values["pr-ready"] && values["pr-remote"] === undefined) return {};
  return {
    delivery: {
      ...(values["no-delivery"] ? { enabled: false } : {}),
      ...(values["pr-ready"] ? { draft: false } : {}),
      ...(values["pr-remote"] !== undefined ? { remote: values["pr-remote"] } : {}),
    },
  };
}

async function runDemo(): Promise<void> {
  const loom = createDemoLoom();
  const cp = loom.controlPlane;
  console.log("Submitting a 3-task epic (task C depends on A and B)...\n");
  const a = cp.dispatchWorker({ definition: demoDef("Build module A") });
  const b = cp.dispatchWorker({ definition: demoDef("Build module B") });
  cp.dispatchWorker({ definition: demoDef("Integrate A + B", [a, b]) });
  console.log("Queue before drain:", JSON.stringify(cp.queryQueue().counts));
  await cp.drain();
  const after = cp.queryQueue();
  console.log("Queue after drain: ", JSON.stringify(after.counts));
  console.log("\nTasks:");
  for (const t of after.tasks) console.log(`  ${t.state.padEnd(10)} ${t.taskType.padEnd(14)} ${t.id}`);
  loom.close();
}

function demoDef(description: string, deps: string[] = []): TaskDefinition {
  return {
    taskType: "implementation",
    description,
    acceptanceCriteria: ["meets the description"],
    priority: 1,
    effort: "medium",
    repo: "example.com",
    baseBranch: "main",
    deps,
    requiresIndependentReview: true,
  };
}

async function runLive(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      registry: { type: "string" },
      repo: { type: "string" },
      task: { type: "string" },
      criteria: { type: "string" },
      type: { type: "string" },
      worker: { type: "string" },
      verify: { type: "string" },
      poll: { type: "string" },
      "resume-from-branch": { type: "string" },
      "no-delivery": { type: "boolean" },
      "pr-ready": { type: "boolean" },
      "pr-remote": { type: "string" },
    },
  });

  if (!values.registry || !values.task) {
    console.error("run: --registry and --task are required.\n");
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const repoRoot = values.repo ?? process.cwd();
  const criteria = parseCriteria(values.criteria);
  if (criteria.length === 0) {
    console.error("run: --criteria is required (the readiness gate rejects tasks without acceptance criteria).");
    process.exitCode = 1;
    return;
  }

  const definition: TaskDefinition = {
    taskType: values.type ?? "implementation",
    description: values.task,
    acceptanceCriteria: criteria,
    priority: 1,
    effort: "medium",
    repo: repoRoot,
    baseBranch: "main",
    deps: [],
    requiresIndependentReview: true,
    ...(values.verify ? { verificationCommand: values.verify } : {}),
    ...(values["resume-from-branch"] ? { resumeFromBranch: values["resume-from-branch"] } : {}),
  };

  const loom = createLiveLoom({
    dbPath: join(repoRoot, ".loom.sqlite"),
    registryPath: values.registry,
    repoRoot,
    ...(values.poll ? { dispatch: { pollDelayMs: Number(values.poll) } } : {}),
    ...deliveryConfig(values),
  });

  try {
    const taskId = loom.controlPlane.dispatchWorker({
      definition,
      ...(values.worker ? { preferredWorkerId: values.worker } : {}),
    });
    console.log(`Submitted task ${taskId} (${definition.taskType}). Running...\n`);
    await loom.controlPlane.drain({ concurrency: 1 });

    const view = loom.controlPlane.getResult(taskId)!;
    console.log(`Task state: ${view.task.state}`);
    for (const r of view.runs) {
      const res = view.results[r.runId] as { status?: string; branchRef?: string } | undefined;
      console.log(`  run ${r.runId.slice(0, 8)} [${r.runSpec.taskType}] ${r.state}${res?.branchRef ? ` -> ${res.branchRef}` : ""}`);
    }
    const escalations = loom.store
      .getEvents(taskId)
      .filter((e) => e.type === "escalation")
      .map((e) => e.data["reason"]);
    if (escalations.length > 0) console.log(`Escalations:\n${escalations.map((r) => `  - ${String(r)}`).join("\n")}`);
  } finally {
    loom.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd ?? "help") {
    case "demo":
      await runDemo();
      break;
    case "run":
      await runLive(rest);
      break;
    case "serve":
      await runServe(rest);
      break;
    case "ui":
      await runUi(rest);
      break;
    case "view":
      await runView(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
