import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { FakeBackend, type FakeScript } from "../src/backends/fake/fakeBackend.js";
import { runBackendConformance } from "./conformance.js";
import { makeRunSpec, freshId } from "./helpers.js";

/** Shared scripting: conformance cases request behavior via taskType. */
const script: FakeScript = (spec) => {
  switch (spec.taskType) {
    case "dispatch-fail":
      return { dispatch: "fail" };
    case "longrun":
      // Several non-terminal polls then completed; the cancel test cancels before it finishes.
      return { phases: ["running", "running", "running", "running", "completed"] };
    default:
      return {};
  }
};

// Variant A: in-memory (models a non-durable backend, crossRestartRecoverable=false).
runBackendConformance("fake (in-memory)", { make: () => new FakeBackend({ script }) });

// Variant B: journal-backed (models a cross-restart-recoverable backend).
const journalPath = join(tmpdir(), `loom-fake-journal-${freshId("j")}.json`);
runBackendConformance("fake (journal-backed)", {
  make: () => new FakeBackend({ script, journalPath }),
});

describe("FakeBackend durability semantics", () => {
  it("in-memory backend declares crossRestartRecoverable=false", () => {
    expect(new FakeBackend().capabilities().crossRestartRecoverable).toBe(false);
  });

  it("journal-backed backend recovers a run from a fresh instance (models a restart)", async () => {
    const path = join(tmpdir(), `loom-fake-durab-${freshId("j")}.json`);
    try {
      const a = new FakeBackend({ journalPath: path });
      expect(a.capabilities().crossRestartRecoverable).toBe(true);
      const spec = makeRunSpec();
      await a.dispatch(spec);

      // Simulate a restart: a brand-new instance sharing the same journal.
      const b = new FakeBackend({ journalPath: path });
      const found = await b.findRun(spec.runId);
      expect(found?.runId).toBe(spec.runId);
      const result = await b.result(found!);
      expect(result.status).toBe("completed");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("deliverables round-trip when structured output is used", async () => {
    const withDeliverable: FakeScript = () => ({
      result: { deliverables: { summary: "did the thing" } },
    });
    const backend = new FakeBackend({ script: withDeliverable });
    const handle = await backend.dispatch(makeRunSpec({ outputSchema: { type: "object" } }));
    const result = await backend.result(handle);
    expect(result.deliverables).toEqual({ summary: "did the thing" });
  });
});
