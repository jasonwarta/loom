/**
 * Platform-side verification + revision-resumes-branch (the "executable
 * acceptance criteria are real" fixes): the verificationCommand is executed in
 * the committed worktree before review; a failure is an objective revise; a
 * revision run continues the prior attempt's branch instead of restarting.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { FakeBackend } from "../src/backends/fake/fakeBackend.js";
import type { Backend, ReviewResult, RunSpec } from "../src/contract/index.js";
import type { IsolationProvider } from "../src/isolation/worktree.js";
import type { IsolationUnit } from "../src/contract/types.js";
import type { Verifier } from "../src/verification/verifier.js";
import type { Reviewer } from "../src/domain/review.js";
import { makeStack, makeTaskDef } from "./helpers.js";

/** Records acquire() calls and hands out fake worktree units (no real git). */
class StubIsolation implements IsolationProvider {
  readonly acquires: Array<{ runId: string; repo: string; baseBranch: string; resumeBranch?: string }> = [];
  async acquire(runId: string, repo: string, baseBranch: string, resumeBranch?: string): Promise<IsolationUnit> {
    this.acquires.push({ runId, repo, baseBranch, ...(resumeBranch !== undefined ? { resumeBranch } : {}) });
    return { mode: "worktree", path: `/fake/worktrees/${runId}`, branch: resumeBranch ?? `loom/${runId}` };
  }
  async commit(): Promise<void> {}
  async release(): Promise<void> {}
}

/** StubIsolation whose branches are scripted empty or not, per call. */
class EmptinessIsolation extends StubIsolation {
  constructor(private readonly outcomes: boolean[]) {
    super();
  }
  private call = 0;
  async hasNewWork(): Promise<boolean> {
    return this.outcomes[Math.min(this.call++, this.outcomes.length - 1)]!;
  }
}

const failingVerifier: Verifier = {
  run: async () => ({ ok: false, exitCode: 1, output: "1 test failed: expected 2, got 3" }),
};
const passingVerifier: Verifier = {
  run: async () => ({ ok: true, exitCode: 0, output: "all green" }),
};

describe("platform-side verification", () => {
  it("a failing verificationCommand becomes an objective revise (reviewer never consulted)", async () => {
    const reviewer: Reviewer = { review: vi.fn(async (): Promise<ReviewResult> => ({ verdict: "accept", findings: [] })) };
    const { cp, store } = makeStack({
      isolation: new StubIsolation(),
      verifier: failingVerifier,
      reviewer,
      retry: { maxRevisions: 1 },
    });
    const taskId = cp.dispatchWorker({
      definition: makeTaskDef({ verificationCommand: "npm test" }),
    });
    await cp.drain();

    // Every attempt failed verification -> revise until the budget, then escalate.
    expect(store.getTask(taskId)?.state).toBe("escalated");
    expect(reviewer.review).not.toHaveBeenCalled(); // no reviewer run wasted on failing work
    const reviews = store.getEvents(taskId).filter((e) => e.type === "review");
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((e) => e.data["verdict"] === "revise")).toBe(true);
  });

  it("the revise findings carry the command output, and the next run gets them as notes", async () => {
    let n = 0;
    const flakyVerifier: Verifier = {
      run: async () => (++n === 1 ? { ok: false, exitCode: 1, output: "boom at line 42" } : { ok: true, exitCode: 0, output: "ok" }),
    };
    const reviewer: Reviewer = { review: async () => ({ verdict: "accept", findings: [] }) };
    const { cp, store } = makeStack({ isolation: new StubIsolation(), verifier: flakyVerifier, reviewer });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ verificationCommand: "make check" }) });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    const runs = store.listRunsByTask(taskId);
    expect(runs).toHaveLength(2);
    const revision = runs[1]!.runSpec;
    expect(revision.priorReviewFindings).toContain("## Prior review findings to address");
    expect(revision.priorReviewFindings).toContain("boom at line 42");
  });

  it("a passing verification proceeds to review and is noted in the review brief", async () => {
    const store = new LoomStore(":memory:");
    const reviewSpecs: RunSpec[] = [];
    const implBackend = new FakeBackend({ id: "impl-be", capabilities: { supportsNativeReview: false } });
    const reviewerBackend = new FakeBackend({
      id: "rev-be",
      capabilities: { supportsNativeReview: false },
      script: (spec) => {
        if (spec.taskType !== "review") return {};
        reviewSpecs.push(spec);
        return { result: { deliverables: { verdict: "accept", findings: [] } } };
      },
    });
    const registry = new Registry([
      { workerId: "impl", backend: "impl-be", model: "m", availability: "available", preferredTaskTypes: ["implementation"] },
      { workerId: "rev", backend: "rev-be", model: "m", availability: "available", preferredTaskTypes: ["review"] },
    ]);
    const isolation = new StubIsolation();
    const cp = new ControlPlane({
      store,
      registry,
      backends: new Map<string, Backend>([
        ["impl-be", implBackend],
        ["rev-be", reviewerBackend],
      ]),
      isolation,
      verifier: passingVerifier,
      dispatch: { pollDelayMs: 0 },
    });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ verificationCommand: "npm test" }) });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    expect(reviewSpecs).toHaveLength(1);
    const spec = reviewSpecs[0]!;
    // The reviewer runs IN the implementer's worktree, read-only.
    expect(spec.isolationUnit.mode).toBe("worktree");
    expect(spec.isolationPolicy.writeScope).toBe("read-only");
    // The brief tells the reviewer verification already passed and uses the base branch.
    const brief = readFileSync(spec.contextPackageRef, "utf8");
    expect(brief).toContain("Verification");
    expect(brief).toContain("npm test");
    expect(brief).toContain("main..HEAD");
    store.close();
  });
});

describe("empty-run guard", () => {
  it("a 'completed' implementation run with no work on its branch fails and retries (no review wasted)", async () => {
    const reviewer: Reviewer = { review: vi.fn(async (): Promise<ReviewResult> => ({ verdict: "accept", findings: [] })) };
    // First run produces nothing (worker asked a question into the void); retry produces work.
    const isolation = new EmptinessIsolation([false, true]);
    const { cp, store } = makeStack({ isolation, reviewer });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    expect(store.listRunsByTask(taskId)).toHaveLength(2); // empty run retried
    expect(reviewer.review).toHaveBeenCalledTimes(1); // only the real work was reviewed
  });

  it("does not apply to non-implementation tasks (an investigation delivers its message, not a branch)", async () => {
    const reviewer: Reviewer = { review: async () => ({ verdict: "accept", findings: [] }) };
    const isolation = new EmptinessIsolation([false]);
    const { cp, store } = makeStack({ isolation, reviewer });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ taskType: "investigation" }) });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
    expect(store.listRunsByTask(taskId)).toHaveLength(1);
  });
});

describe("revision resumes the prior branch", () => {
  it("re-acquires the SAME branch on a revise (not a fresh branch off base)", async () => {
    let verdicts = 0;
    const reviseOnce: Reviewer = {
      review: async (): Promise<ReviewResult> =>
        ++verdicts === 1
          ? { verdict: "revise", findings: [{ severity: "S1", title: "fix the edge case" }] }
          : { verdict: "accept", findings: [] },
    };
    const isolation = new StubIsolation();
    const { cp, store } = makeStack({ isolation, reviewer: reviseOnce });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    expect(isolation.acquires).toHaveLength(2);
    const firstBranch = `loom/${isolation.acquires[0]!.runId}`;
    expect(isolation.acquires[0]!.resumeBranch).toBeUndefined();
    expect(isolation.acquires[1]!.resumeBranch).toBe(firstBranch); // continues the reviewed work
    // The revision run is marked as resumed work.
    const runs = store.listRunsByTask(taskId);
    expect(runs[1]!.runSpec.resumedWork).toBe(true);
  });

  it("clears the revise branch on accept so later tasks are unaffected", async () => {
    let verdicts = 0;
    const reviseOnce: Reviewer = {
      review: async (): Promise<ReviewResult> =>
        ++verdicts === 1 ? { verdict: "revise", findings: [] } : { verdict: "accept", findings: [] },
    };
    const isolation = new StubIsolation();
    const { cp, store } = makeStack({ isolation, reviewer: reviseOnce });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
    expect(store.getTaskMeta(taskId, "reviseBranch")).toBeUndefined();
    expect(store.getTaskMeta(taskId, "revisionNotes")).toBeUndefined();
  });
});
