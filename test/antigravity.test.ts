import { AntigravityBackend } from "../src/backends/antigravity/antigravityBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import { runBackendConformance } from "./conformance.js";

/**
 * The Antigravity (agy) backend passes the SAME conformance suite as the JSONL
 * backends -- but its output is PLAIN TEXT, captured via onRawLine. That the one
 * contract accommodates both shapes is the strongest extensibility evidence yet.
 */
const agyScript: FakeScript = (proc) => {
  const joined = proc.args.join(" ");
  if (joined.includes("type=dispatch-fail")) return { throwOnStart: true };
  if (joined.includes("type=longrun")) return { lines: ["working..."], hang: true };
  return { lines: ["DONE"], exitCode: 0 }; // plain text, not JSON
};

runBackendConformance("antigravity/agy (fake runner)", {
  make: () => new AntigravityBackend(new FakeProcessRunner(agyScript)),
});
