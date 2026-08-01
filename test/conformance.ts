/**
 * Backend conformance suite -- the executable definition of the Backend
 * contract. Any backend (fake or real) must pass this. If a real adapter fails
 * a case here, the adapter is wrong; if the suite is awkward to satisfy, the
 * contract is wrong (IMPLEMENTATION-PLAN M0).
 */

import { describe, it, expect } from "vitest";
import { BackendError, type Backend, type RunPhase } from "../src/contract/index.js";
import { makeRunSpec } from "./helpers.js";

const TERMINAL: RunPhase[] = ["completed", "errored", "cancelled", "timed_out"];

/** A backend factory plus a scripting hook so cases can request specific outcomes. */
export interface ConformanceHooks {
  /** Make a fresh backend. `scriptByTaskType` lets the factory wire outcomes keyed by taskType. */
  make: () => Backend;
}

async function pollToTerminal(backend: Backend, handle: Awaited<ReturnType<Backend["dispatch"]>>, max = 20) {
  let last = await backend.poll(handle);
  for (let i = 0; i < max && !TERMINAL.includes(last.phase); i++) {
    last = await backend.poll(handle);
  }
  return last;
}

export function runBackendConformance(name: string, hooks: ConformanceHooks): void {
  describe(`Backend conformance: ${name}`, () => {
    it("declares well-formed capabilities", () => {
      const caps = hooks.make().capabilities();
      expect(typeof caps.supportsResume).toBe("boolean");
      expect(typeof caps.reportsCost).toBe("boolean");
      expect(typeof caps.crossRestartRecoverable).toBe("boolean");
      expect(caps.isolationModes.length).toBeGreaterThan(0);
      expect(caps.maxConcurrentRuns === null || caps.maxConcurrentRuns > 0).toBe(true);
    });

    it("dispatch returns a handle keyed to the platform runId and this backend", async () => {
      const backend = hooks.make();
      const spec = makeRunSpec();
      const handle = await backend.dispatch(spec);
      expect(handle.runId).toBe(spec.runId);
      expect(handle.backendId).toBe(backend.id);
      expect(typeof handle.createdAt).toBe("number");
    });

    it("poll reaches a terminal phase and result is retrievable", async () => {
      const backend = hooks.make();
      const spec = makeRunSpec({ taskType: "completes" });
      const handle = await backend.dispatch(spec);
      const status = await pollToTerminal(backend, handle);
      expect(TERMINAL).toContain(status.phase);
      const result = await backend.result(handle);
      expect(result.runId).toBe(spec.runId);
      expect(result.status).toBe("completed");
    });

    it("poll after terminal is stable (idempotent-safe)", async () => {
      const backend = hooks.make();
      const handle = await backend.dispatch(makeRunSpec({ taskType: "completes" }));
      await pollToTerminal(backend, handle);
      const a = await backend.poll(handle);
      const b = await backend.poll(handle);
      expect(a.phase).toBe(b.phase);
      expect(TERMINAL).toContain(a.phase);
    });

    it("cancel stops a long run and is idempotent", async () => {
      const backend = hooks.make();
      // "longrun" outcome must not terminate on its own before we cancel.
      const handle = await backend.dispatch(makeRunSpec({ taskType: "longrun" }));
      await backend.poll(handle);
      await backend.cancel(handle);
      await backend.cancel(handle); // second cancel: no throw
      const status = await backend.poll(handle);
      expect(status.phase).toBe("cancelled");
      const result = await backend.result(handle);
      expect(result.status).toBe("cancelled");
    });

    it("findRun recovers a known run and returns null for an unknown one", async () => {
      const backend = hooks.make();
      const spec = makeRunSpec();
      await backend.dispatch(spec);
      const found = await backend.findRun(spec.runId);
      expect(found?.runId).toBe(spec.runId);
      const missing = await backend.findRun("does-not-exist");
      expect(missing).toBeNull();
    });

    it("resume returns a usable handle when supported", async () => {
      const backend = hooks.make();
      if (!backend.capabilities().supportsResume) return;
      const spec = makeRunSpec();
      const handle = await backend.dispatch(spec);
      const resumed = await backend.resume(handle, "keep going");
      expect(resumed.runId).toBe(spec.runId);
    });

    it("normalizes errors: unknown handle throws BackendError(not_found)", async () => {
      const backend = hooks.make();
      const bogus = { runId: "nope", backendId: backend.id, native: {}, createdAt: 0 };
      await expect(backend.poll(bogus)).rejects.toBeInstanceOf(BackendError);
      await expect(backend.poll(bogus)).rejects.toMatchObject({ code: "not_found" });
    });

    it("dispatch failure surfaces as BackendError(dispatch_failed)", async () => {
      const backend = hooks.make();
      const spec = makeRunSpec({ taskType: "dispatch-fail" });
      await expect(backend.dispatch(spec)).rejects.toMatchObject({
        name: "BackendError",
        code: "dispatch_failed",
      });
    });

    it("healthcheck returns a valid availability", async () => {
      const health = await hooks.make().healthcheck();
      expect(["available", "degraded", "offline", "rate_limited"]).toContain(health.status);
    });
  });
}
