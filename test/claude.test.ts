import { ClaudeBackend } from "../src/backends/claude/claudeBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import { runBackendConformance } from "./conformance.js";

/**
 * Claude adapter conformance, run with a fake process runner emitting
 * claude stream-json events (init + result). Same taskType-in-prompt branching.
 */
const claudeScript: FakeScript = (proc) => {
  const joined = proc.args.join(" ");
  if (joined.includes("type=dispatch-fail")) return { throwOnStart: true };

  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-1" });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "claude fake final message",
    session_id: "claude-sess-1",
    total_cost_usd: 0.0123,
  });

  if (joined.includes("type=longrun")) {
    return { lines: [init, JSON.stringify({ type: "assistant" })], hang: true };
  }
  return { lines: [init, JSON.stringify({ type: "assistant" }), result], exitCode: 0 };
};

runBackendConformance("claude (fake runner)", {
  make: () => new ClaudeBackend(new FakeProcessRunner(claudeScript)),
});
