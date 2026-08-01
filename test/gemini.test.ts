import { GeminiBackend } from "../src/backends/gemini/geminiBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import { runBackendConformance } from "./conformance.js";

/**
 * The THIRD backend passes the SAME conformance suite as Codex and Claude with a
 * gemini-shaped fake runner. Together with the dependency-direction guard
 * (architecture.test.ts) and a clean diff (adapter + composition root only),
 * this is the prime-directive proof: a new provider costs an adapter + a
 * registry entry, nothing above the boundary.
 */
const geminiScript: FakeScript = (proc) => {
  const joined = proc.args.join(" ");
  if (joined.includes("type=dispatch-fail")) return { throwOnStart: true };

  const init = JSON.stringify({ type: "session", session_id: "gem-1" });
  const result = JSON.stringify({ type: "result", response: "gemini fake final message" });

  if (joined.includes("type=longrun")) return { lines: [init], hang: true };
  return { lines: [init, result], exitCode: 0 };
};

runBackendConformance("gemini (fake runner)", {
  make: () => new GeminiBackend(new FakeProcessRunner(geminiScript)),
});
