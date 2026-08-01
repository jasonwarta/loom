import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { CodexBackend } from "../src/backends/codex/codexBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import type { Backend } from "../src/contract/index.js";
import { makeTaskDef } from "./helpers.js";

// A backend run that never finishes on its own.
const hangScript: FakeScript = () => ({
  lines: [JSON.stringify({ type: "session.created", session_id: "c" })],
  hang: true,
});

describe("wall-clock timeout", () => {
  it("cancels a hung run and records timed_out when the budget is exceeded", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([
      { workerId: "w", backend: "codex", model: "m", availability: "available" },
    ]);
    const backends = new Map<string, Backend>([["codex", new CodexBackend(new FakeProcessRunner(hangScript))]]);

    // Deterministic clock: advances 10ms per call.
    let t = 0;
    const now = () => {
      t += 10;
      return t;
    };
    // maxAttempts: 1 so a single timeout escalates (no retry loop) -- keeps this
    // test focused on the timeout mechanism, not the retry policy.
    const cp = new ControlPlane({ store, registry, backends, retry: { maxAttempts: 1 }, dispatch: { pollDelayMs: 0, now } });

    const taskId = cp.dispatchWorker({ definition: makeTaskDef({ wallClockMs: 25 }) });
    await cp.drain();

    // One hung run timed out; with no retries left the task escalates.
    expect(store.getTask(taskId)?.state).toBe("escalated");
    const run = store.listRunsByTask(taskId)[0]!;
    expect(run.state).toBe("timed_out");
    store.close();
  });
});
