import { describe, it, expect } from "vitest";
import { checkTaskReadiness } from "../src/domain/readiness.js";
import { makeStack, makeTaskDef } from "./helpers.js";

describe("task-readiness checker", () => {
  it("passes a task with a description and acceptance criteria", () => {
    expect(checkTaskReadiness(makeTaskDef()).ready).toBe(true);
  });

  it("fails a task with no acceptance criteria", () => {
    const r = checkTaskReadiness(makeTaskDef({ acceptanceCriteria: [] }));
    expect(r.ready).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/acceptance criteria/);
  });

  it("fails an empty-string-only criteria list", () => {
    expect(checkTaskReadiness(makeTaskDef({ acceptanceCriteria: ["  "] })).ready).toBe(false);
  });

  it("under a strict policy, requires an executable verification command", () => {
    const strict = { requireExecutableVerification: true };
    expect(checkTaskReadiness(makeTaskDef(), strict).ready).toBe(false);
    expect(checkTaskReadiness(makeTaskDef({ verificationCommand: "npm test -- foo" }), strict).ready).toBe(true);
  });
});

describe("admission gate in the control plane", () => {
  it("escalates an underspecified task at admission instead of dispatching it", async () => {
    const { cp, store } = makeStack();
    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ acceptanceCriteria: [] }) });
    // Escalated immediately; never queued, never run.
    expect(store.getTask(taskId)?.state).toBe("escalated");
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("escalated");
    expect(store.listRunsByTask(taskId)).toHaveLength(0);
  });

  it("admits and completes a dispatch-ready task", async () => {
    const { cp, store } = makeStack();
    const taskId = cp.dispatchWorker({ definition: makeTaskDef() });
    expect(store.getTask(taskId)?.state).toBe("queued");
    await cp.drain();
    expect(store.getTask(taskId)?.state).toBe("completed");
  });

  it("under a strict policy, escalates a task lacking an executable verification but admits one with it", async () => {
    const { cp, store } = makeStack({ readiness: { requireExecutableVerification: true } });

    const noVerify = cp.dispatchWorker({ definition: makeTaskDef() });
    expect(store.getTask(noVerify)?.state).toBe("escalated");

    const withVerify = cp.dispatchWorker({ definition: makeTaskDef({ verificationCommand: "pnpm test" }) });
    expect(store.getTask(withVerify)?.state).toBe("queued");
    await cp.drain();
    expect(store.getTask(withVerify)?.state).toBe("completed");
  });
});
