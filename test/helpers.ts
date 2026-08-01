import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunSpec, RunId, TaskId } from "../src/contract/index.js";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { FakeBackend, type FakeScript } from "../src/backends/fake/fakeBackend.js";
import type { Reviewer } from "../src/domain/review.js";
import type { TaskDefinition } from "../src/domain/model.js";

let counter = 0;
export function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function tmpPath(ext: string): string {
  // randomUUID (not the per-process counter) so parallel test files never
  // collide on a shared tmpdir path.
  return join(tmpdir(), `loom-${randomUUID()}.${ext}`);
}

/** A default task definition with overridable fields. */
export function makeTaskDef(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskType: overrides.taskType ?? "implementation",
    description: overrides.description ?? "do the thing",
    acceptanceCriteria: overrides.acceptanceCriteria ?? ["it works"],
    priority: overrides.priority ?? 1,
    effort: overrides.effort ?? "medium",
    repo: overrides.repo ?? "example.com",
    baseBranch: overrides.baseBranch ?? "main",
    deps: overrides.deps ?? [],
    requiresIndependentReview: overrides.requiresIndependentReview ?? false,
    ...(overrides.wallClockMs !== undefined ? { wallClockMs: overrides.wallClockMs } : {}),
    ...(overrides.contextFiles !== undefined ? { contextFiles: overrides.contextFiles } : {}),
    ...(overrides.verificationCommand !== undefined ? { verificationCommand: overrides.verificationCommand } : {}),
    ...(overrides.resumeFromBranch !== undefined ? { resumeFromBranch: overrides.resumeFromBranch } : {}),
  };
}

export interface Stack {
  store: LoomStore;
  backend: FakeBackend;
  registry: Registry;
  cp: ControlPlane;
  dbPath: string;
  journalPath?: string;
}

/** Build a full single-worker stack. dbPath/journalPath let tests model a restart by rebuilding with the same paths. */
export function makeStack(opts: {
  dbPath?: string;
  journalPath?: string;
  script?: FakeScript;
  reviewer?: Reviewer;
  readiness?: import("../src/domain/readiness.js").ReadinessPolicy;
  retry?: { maxAttempts?: number; maxRevisions?: number; maxCrashes?: number };
  isolation?: import("../src/isolation/worktree.js").IsolationProvider;
  verifier?: import("../src/verification/verifier.js").Verifier;
} = {}): Stack {
  const dbPath = opts.dbPath ?? ":memory:";
  const store = new LoomStore(dbPath);
  const backend = new FakeBackend({
    ...(opts.script ? { script: opts.script } : {}),
    ...(opts.journalPath ? { journalPath: opts.journalPath } : {}),
  });
  // Two workers so real (default) review has an INDEPENDENT reviewer:
  // w1 implements, w-reviewer reviews (native review on the fake adds no extra run).
  const registry = new Registry([
    { workerId: "w1", backend: "fake", model: "fake-model", availability: "available", preferredTaskTypes: ["implementation"] },
    {
      workerId: "w-reviewer",
      backend: "fake",
      model: "fake-review",
      availability: "available",
      preferredTaskTypes: ["review"],
      strengths: { review: 90 },
    },
  ]);
  const cp = new ControlPlane({
    store,
    registry,
    backends: new Map([["fake", backend]]),
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    ...(opts.readiness ? { readiness: opts.readiness } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
    dispatch: { pollDelayMs: 0 },
  });
  return { store, backend, registry, cp, dbPath, ...(opts.journalPath ? { journalPath: opts.journalPath } : {}) };
}

/** Build a minimal, valid RunSpec with overridable fields. */
export function makeRunSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  const runId: RunId = overrides.runId ?? freshId("run");
  const taskId: TaskId = overrides.taskId ?? freshId("task");
  return {
    runId,
    taskId,
    taskType: overrides.taskType ?? "implementation",
    effort: overrides.effort ?? "medium",
    contextPackageRef: overrides.contextPackageRef ?? "ctx-ref",
    repo: overrides.repo ?? "example.com",
    baseBranch: overrides.baseBranch ?? "main",
    isolationUnit: overrides.isolationUnit ?? { mode: "none" },
    isolationPolicy: overrides.isolationPolicy ?? { writeScope: "workspace", networkEgress: "none" },
    constraints: overrides.constraints ?? {},
    expectedDeliverables: overrides.expectedDeliverables ?? ["a branch"],
    ...(overrides.modelPreference !== undefined ? { modelPreference: overrides.modelPreference } : {}),
    ...(overrides.outputSchema !== undefined ? { outputSchema: overrides.outputSchema } : {}),
  };
}
