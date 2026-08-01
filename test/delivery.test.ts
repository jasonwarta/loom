import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { FakeBackend } from "../src/backends/fake/fakeBackend.js";
import { GitHubDelivery } from "../src/delivery/delivery.js";
import type { Backend, IsolationUnit, ReviewResult } from "../src/contract/index.js";
import type { IsolationProvider } from "../src/isolation/worktree.js";
import type { DeliveryProvider, DeliveryOutcome, DeliveryRequest } from "../src/delivery/delivery.js";
import type { Reviewer } from "../src/domain/review.js";
import { makeTaskDef } from "./helpers.js";

/** Isolation that hands back a worktree unit without touching git (unit test speed). */
class FakeIsolation implements IsolationProvider {
  readonly acquired: Array<{ runId: string; resumeBranch?: string }> = [];
  async acquire(runId: string, _repo: string, _base: string, resumeBranch?: string): Promise<IsolationUnit> {
    this.acquired.push({ runId, ...(resumeBranch !== undefined ? { resumeBranch } : {}) });
    return { mode: "worktree", path: `/tmp/loom-fake/${runId}`, branch: resumeBranch ?? `loom/${runId}` };
  }
  async commit(): Promise<void> {}
  async release(): Promise<void> {}
}

class FakeDelivery implements DeliveryProvider {
  readonly calls: Array<{ unit: IsolationUnit; req: DeliveryRequest }> = [];
  constructor(private readonly behavior: (req: DeliveryRequest) => Promise<DeliveryOutcome> = async () => ({
    pushed: true,
    prUrl: "https://github.com/o/r/pull/7",
  })) {}
  async publish(unit: IsolationUnit, req: DeliveryRequest): Promise<DeliveryOutcome> {
    this.calls.push({ unit, req });
    return this.behavior(req);
  }
}

const accept: Reviewer = { async review(): Promise<ReviewResult> {
  return { verdict: "accept", findings: [] };
} };
const reject: Reviewer = { async review(): Promise<ReviewResult> {
  return { verdict: "reject", findings: [{ severity: "S0", title: "no" }] };
} };

function makeCp(opts: { reviewer: Reviewer; isolation: IsolationProvider; delivery?: DeliveryProvider }) {
  const store = new LoomStore(":memory:");
  const registry = new Registry([
    { workerId: "w1", backend: "fake", model: "m", availability: "available", preferredTaskTypes: ["implementation"] },
  ]);
  const cp = new ControlPlane({
    store,
    registry,
    backends: new Map<string, Backend>([["fake", new FakeBackend()]]),
    reviewer: opts.reviewer,
    isolation: opts.isolation,
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
    dispatch: { pollDelayMs: 0 },
  });
  return { store, cp };
}

function completionReason(store: LoomStore, taskId: string): string | undefined {
  const ev = store
    .getEvents(taskId)
    .find((e) => e.type === "task.state" && e.data["state"] === "completed");
  return ev?.data["reason"] as string | undefined;
}

describe("platform-side delivery", () => {
  it("pushes + opens a PR on accept, recording the PR url on completion", async () => {
    const delivery = new FakeDelivery();
    const { store, cp } = makeCp({ reviewer: accept, isolation: new FakeIsolation(), delivery });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed");
    expect(delivery.calls).toHaveLength(1);
    expect(delivery.calls[0]!.unit.mode).toBe("worktree");
    expect(delivery.calls[0]!.req.baseBranch).toBe("main");
    expect(completionReason(store, taskId)).toContain("https://github.com/o/r/pull/7");
    store.close();
  });

  it("does NOT deliver when review rejects", async () => {
    const delivery = new FakeDelivery();
    const { store, cp } = makeCp({ reviewer: reject, isolation: new FakeIsolation(), delivery });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("escalated");
    expect(delivery.calls).toHaveLength(0);
    store.close();
  });

  it("a delivery failure is non-fatal: task still completes, failure is escalated for a manual push", async () => {
    const failing = new FakeDelivery(async () => {
      throw new Error("gh: not authenticated");
    });
    const { store, cp } = makeCp({ reviewer: accept, isolation: new FakeIsolation(), delivery: failing });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    expect(store.getTask(taskId)?.state).toBe("completed"); // work is committed; not lost
    const escalation = store.getEvents(taskId).find((e) => e.type === "escalation");
    expect(escalation?.data["reason"]).toContain("delivery failed");
    store.close();
  });

  it("delivery is opt-in: without a provider, accepted work stays on its branch (no throw)", async () => {
    const { store, cp } = makeCp({ reviewer: accept, isolation: new FakeIsolation() });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
    store.close();
  });
});

describe("recovery mode threading", () => {
  it("passes resumeFromBranch to isolation.acquire and flags resumedWork on the run spec", async () => {
    const iso = new FakeIsolation();
    const { store, cp } = makeCp({ reviewer: accept, isolation: iso });
    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ resumeFromBranch: "feature/x" }) });
    await cp.drain();

    expect(iso.acquired[0]?.resumeBranch).toBe("feature/x");
    const implRun = store.listRunsByTask(taskId).find((r) => r.runSpec.taskType !== "review");
    expect(implRun?.runSpec.resumedWork).toBe(true);
    store.close();
  });
});

describe("GitHubDelivery", () => {
  it("is a no-op for non-worktree runs (nothing to push)", async () => {
    const gh = new GitHubDelivery({ repoRoot: "/nonexistent" });
    const outcome = await gh.publish(
      { mode: "none" },
      { taskId: "t", title: "x", body: "y", baseBranch: "main" },
    );
    expect(outcome).toEqual({ pushed: false });
  });
});
