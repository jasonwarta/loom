import { describe, it, expect } from "vitest";
import { makeStack, makeTaskDef } from "./helpers.js";

describe("monitoring: getStatus", () => {
  it("aggregates task/run/review state, cost, and utilization", async () => {
    const { cp } = makeStack();
    cp.dispatchWorker({ definition: makeTaskDef() });
    cp.dispatchWorker({ definition: makeTaskDef() });
    await cp.drain();

    const status = cp.getStatus();
    expect(status.tasksByState["completed"]).toBe(2);
    expect(status.runsByState["completed"]).toBe(2); // native review adds no run
    expect(status.runsByWorker["w1"]).toBe(2); // both implemented by w1
    expect(status.reviewsByVerdict["accept"]).toBe(2);
    expect(typeof status.totalCostUsd).toBe("number");
    expect(status.utilization).toBeDefined(); // back to 0 after completion
  });

  it("surfaces escalations in the aggregate", async () => {
    const { cp } = makeStack();
    // Missing acceptance criteria -> readiness gate escalates at admission.
    cp.dispatchWorker({ definition: makeTaskDef({ acceptanceCriteria: [] }) });
    await cp.drain();
    const status = cp.getStatus();
    expect(status.tasksByState["escalated"]).toBe(1);
    expect(status.escalations).toBeGreaterThanOrEqual(1);
  });
});
