import { writeFileSync } from "node:fs";
import { CodexBackend } from "../src/backends/codex/codexBackend.js";
import { FakeProcessRunner, type FakeScript } from "../src/backends/process/fakeRunner.js";
import { runBackendConformance } from "./conformance.js";

/**
 * Codex adapter conformance, run with a fake process runner emitting
 * codex-shaped JSONL. Conformance cases select behavior via the taskType, which
 * the adapter embeds in the prompt ("type=<taskType>") so the fake can branch.
 */
const codexScript: FakeScript = (proc) => {
  const joined = proc.args.join(" ");
  if (joined.includes("type=dispatch-fail")) return { throwOnStart: true };

  const oIdx = proc.args.indexOf("-o");
  const oFile = oIdx >= 0 ? proc.args[oIdx + 1] : undefined;
  const sideEffect = () => {
    if (oFile) writeFileSync(oFile, "codex fake final message");
  };
  // Matches real codex 0.144.1 exec --json: thread.started carries thread_id.
  const session = JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" });

  if (joined.includes("type=longrun")) {
    return { lines: [session, JSON.stringify({ type: "turn.started" })], hang: true, sideEffect };
  }
  return {
    lines: [session, JSON.stringify({ type: "item.completed" }), JSON.stringify({ type: "turn.completed" })],
    exitCode: 0,
    sideEffect,
  };
};

runBackendConformance("codex (fake runner)", {
  make: () => new CodexBackend(new FakeProcessRunner(codexScript)),
});
