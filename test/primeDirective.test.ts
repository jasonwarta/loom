/**
 * The prime-directive acceptance test (IMPLEMENTATION-PLAN M1): two dissimilar
 * backends -- Codex and Claude -- run the SAME task definitions through the SAME
 * ControlPlane, scheduler, dispatcher, and persistence, with NO backend-specific
 * code above the adapter boundary. Adding the second backend was a registry
 * entry + a backends-map entry; nothing else.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { LoomStore } from "../src/persistence/store.js";
import { Registry } from "../src/scheduler/registry.js";
import { ControlPlane } from "../src/daemon/controlPlane.js";
import { CodexBackend } from "../src/backends/codex/codexBackend.js";
import { ClaudeBackend } from "../src/backends/claude/claudeBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import { AutoAcceptReviewer } from "../src/domain/review.js";
import type { Backend } from "../src/contract/index.js";
import { makeTaskDef } from "./helpers.js";

const codexScript: FakeScript = (proc) => {
  const oIdx = proc.args.indexOf("-o");
  const oFile = oIdx >= 0 ? proc.args[oIdx + 1] : undefined;
  return {
    lines: [JSON.stringify({ type: "thread.started", thread_id: "c1" })],
    exitCode: 0,
    sideEffect: () => {
      if (oFile) writeFileSync(oFile, "codex output");
    },
  };
};

const claudeScript: FakeScript = () => ({
  lines: [
    JSON.stringify({ type: "system", subtype: "init", session_id: "a1" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "claude output", total_cost_usd: 0.01 }),
  ],
  exitCode: 0,
});

describe("prime directive: one control plane, two backends", () => {
  it("runs the same task shape on Codex and Claude with no code above the boundary", async () => {
    const store = new LoomStore(":memory:");
    const registry = new Registry([
      { workerId: "w-codex", backend: "codex", model: "gpt-5.6-sol", availability: "available" },
      { workerId: "w-claude", backend: "claude", model: "claude-sonnet-5", availability: "available" },
    ]);
    const backends = new Map<string, Backend>([
      ["codex", new CodexBackend(new FakeProcessRunner(codexScript))],
      ["claude", new ClaudeBackend(new FakeProcessRunner(claudeScript))],
    ]);
    // This test exercises backend routing, not review; auto-accept keeps it focused.
    const cp = new ControlPlane({ store, registry, backends, reviewer: new AutoAcceptReviewer(), dispatch: { pollDelayMs: 0 } });

    const viaCodex = cp.dispatchWorker({ definition: makeTaskDef({ description: "on codex" }), preferredWorkerId: "w-codex" });
    const viaClaude = cp.dispatchWorker({ definition: makeTaskDef({ description: "on claude" }), preferredWorkerId: "w-claude" });

    await cp.drain();

    const codexView = cp.getResult(viaCodex)!;
    const claudeView = cp.getResult(viaClaude)!;

    expect(codexView.task.state).toBe("completed");
    expect(codexView.runs[0]!.backendId).toBe("codex");
    expect(claudeView.task.state).toBe("completed");
    expect(claudeView.runs[0]!.backendId).toBe("claude");

    store.close();
  });
});
