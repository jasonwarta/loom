import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { FakeBackend } from "../src/backends/fake/fakeBackend.js";
import type { Backend } from "../src/contract/backend.js";

/**
 * Live availability: refreshHealth() probes each backend's healthcheck() and
 * pushes the result into registry availability (ARCHITECTURE section 19), so the
 * scheduler routes around unhealthy workers and the dashboard shows it live.
 */
describe("live availability: refreshHealth", () => {
  it("pushes a backend's health status into every worker on it + stamps lastHealthAt", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([
      { workerId: "a", backend: "fake", model: "m", availability: "available" },
      { workerId: "b", backend: "fake", model: "m", availability: "available" },
    ]);
    const backend = new FakeBackend({ health: { status: "degraded" } });
    const cp = new ControlPlane({ store, registry, backends: new Map([["fake", backend]]) });

    await cp.refreshHealth();

    for (const id of ["a", "b"]) {
      const w = registry.get(id)!;
      expect(w.availability).toBe("degraded");
      expect(typeof w.lastHealthAt).toBe("number");
    }
    store.close();
  });

  it("marks workers offline when their backend healthcheck throws (unreachable != available)", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([{ workerId: "a", backend: "flaky", model: "m", availability: "available" }]);
    const throwing = {
      id: "flaky",
      healthcheck: async () => {
        throw new Error("unreachable");
      },
    } as unknown as Backend;
    const cp = new ControlPlane({ store, registry, backends: new Map([["flaky", throwing]]) });

    await cp.refreshHealth();

    expect(registry.get("a")!.availability).toBe("offline");
    store.close();
  });

  it("is a no-op with no backends, so observe mode keeps static config availability", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([{ workerId: "a", backend: "fake", model: "m", availability: "available" }]);
    const cp = new ControlPlane({ store, registry, backends: new Map() });

    await cp.refreshHealth();

    const w = registry.get("a")!;
    expect(w.availability).toBe("available");
    expect(w.lastHealthAt).toBeUndefined(); // untouched -> value is still static config, not a live signal
    store.close();
  });
});
