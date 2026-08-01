/**
 * Review abstraction (ARCHITECTURE section 17).
 *
 * M0 ships ONLY a placeholder auto-accept reviewer so the full task lifecycle
 * (running -> review -> completed) can round-trip end to end. The real
 * independent-reviewer pipeline -- a different worker sees the diff + acceptance
 * criteria and returns a structured verdict, with a bounded revise loop -- is
 * M2. This interface is the seam M2 slots into without changing the daemon.
 */

import type { ReviewResult, RunResult } from "../contract/index.js";
import type { RunRecord, TaskRecord } from "./model.js";

export interface Reviewer {
  review(task: TaskRecord, run: RunRecord, result: RunResult): Promise<ReviewResult>;
}

/** M0 placeholder: accepts any successful run. NOT a real review. Replaced in M2. */
export class AutoAcceptReviewer implements Reviewer {
  async review(_task: TaskRecord, _run: RunRecord, result: RunResult): Promise<ReviewResult> {
    if (result.status === "completed") {
      return { verdict: "accept", findings: [] };
    }
    return {
      verdict: "reject",
      findings: [{ severity: "S0", title: `run did not complete (status=${result.status})` }],
    };
  }
}
