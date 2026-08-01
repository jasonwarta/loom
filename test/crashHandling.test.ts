import { describe, it, expect } from "vitest";
import { ClaudeBackend } from "../src/backends/claude/claudeBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import type { Backend, RunError, RunPhase } from "../src/contract/index.js";
import type { IsolationUnit } from "../src/contract/types.js";
import { makeRunSpec, makeStack, makeTaskDef } from "./helpers.js";
import type { FakeScript as BackendScript } from "../src/backends/fake/fakeBackend.js";
import type { IsolationProvider } from "../src/isolation/worktree.js";

const TERMINAL: RunPhase[] = ["completed", "errored", "cancelled", "timed_out"];

async function driveToResult(backend: Backend, spec = makeRunSpec()) {
  const handle = await backend.dispatch(spec);
  let status = await backend.poll(handle);
  for (let i = 0; i < 100 && !TERMINAL.includes(status.phase); i++) {
    status = await backend.poll(handle);
  }
  return backend.result(handle);
}

describe("crash diagnosis at the backend boundary", () => {
  it("surfaces the kill signal so an OOM/SIGKILL is diagnosable (not just 'exited null')", async () => {
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
    const script: FakeScript = () => ({ lines: [init], signal: "SIGKILL" });
    const result = await driveToResult(new ClaudeBackend(new FakeProcessRunner(script)));

    expect(result.status).toBe("errored");
    expect(result.error?.message).toContain("signal SIGKILL");
    expect(result.error?.retryable).toBe(true); // a signal-death may be transient; retry is allowed
  });

  it("classifies a spawn failure (missing binary) as non-retryable dispatch_failed", async () => {
    const script: FakeScript = () => ({ spawnError: "Error: spawn claude ENOENT" });
    const result = await driveToResult(new ClaudeBackend(new FakeProcessRunner(script)));

    expect(result.status).toBe("errored");
    expect(result.error?.code).toBe("dispatch_failed");
    expect(result.error?.retryable).toBe(false); // retrying a missing CLI cannot help
    expect(result.error?.message).toContain("ENOENT");
  });
});

/** Fake control-plane backend: review runs pass; impl runs fail with the given error. */
function failImplWith(error: RunError): BackendScript {
  return (spec) => (spec.taskType === "review" ? {} : { phases: ["errored"], result: { error } });
}

describe("orchestrator crash handling", () => {
  it("escalates a non-retryable failure immediately instead of burning retries", async () => {
    const { cp, store } = makeStack({
      retry: { maxAttempts: 3, maxCrashes: 3 },
      script: failImplWith({ code: "dispatch_failed", message: "failed to start claude: ENOENT", retryable: false }),
    });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("escalated");
    // Exactly ONE impl run: a non-retryable failure is not retried.
    expect(store.listRunsByTask(taskId).filter((r) => r.runSpec.taskType !== "review" && r.state === "errored")).toHaveLength(1);
    expect(cp.getStatus().openEscalations.some((e) => e.reason.includes("non-retryable"))).toBe(true);
  });

  it("stops after the crash budget, independent of the (larger) attempt budget", async () => {
    const { cp, store } = makeStack({
      // A generous attempt budget: only the crash budget should stop the loop.
      retry: { maxAttempts: 10, maxCrashes: 2 },
      script: (spec) => (spec.taskType === "review" ? {} : { phases: ["errored"] }),
    });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("escalated");
    expect(store.listRunsByTask(taskId).filter((r) => r.state === "errored")).toHaveLength(2);
    expect(cp.getStatus().openEscalations.some((e) => e.reason.includes("crashed 2"))).toBe(true);
  });

  it("bounds and escalates when isolation acquisition keeps failing (no infinite re-queue)", async () => {
    // acquire() fails BEFORE startRun records a run. Without the fix, no attempt
    // is ever counted, so the task re-queues forever. Each failed acquire must be
    // recorded as an errored run so the crash budget bounds and escalates it.
    let acquireCalls = 0;
    const throwingIsolation: IsolationProvider = {
      async acquire(): Promise<IsolationUnit> {
        acquireCalls++;
        throw new Error("worktree create failed: disk full");
      },
      async commit() {},
      async release() {},
    };
    const { cp, store } = makeStack({ retry: { maxCrashes: 2 }, isolation: throwingIsolation });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("escalated");
    // Bounded by the crash budget: exactly 2 recorded errored runs, 2 acquires.
    expect(store.listRunsByTask(taskId).filter((r) => r.state === "errored")).toHaveLength(2);
    expect(acquireCalls).toBe(2);
    // The failure is diagnosable in the run result and the escalation reason.
    const errored = store.listRunsByTask(taskId).find((r) => r.state === "errored")!;
    expect(store.getResult(errored.runId)?.error?.message).toContain("disk full");
    expect(cp.getStatus().openEscalations.some((e) => e.reason.includes("disk full"))).toBe(true);
  });

  it("threads the worker's diagnosable reason through to the escalation record", async () => {
    const { cp, store } = makeStack({
      retry: { maxCrashes: 1 },
      script: failImplWith({ code: "transient", message: "claude exited 137 (signal SIGKILL)", retryable: true }),
    });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("escalated");
    // The escalation carries WHY, not just "run errored".
    expect(cp.getStatus().openEscalations.some((e) => e.reason.includes("claude exited 137 (signal SIGKILL)"))).toBe(true);
  });
});
