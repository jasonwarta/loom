/**
 * Gemini backend -- the THIRD backend, added to prove the prime directive
 * (ARCHITECTURE section 9.3, IMPLEMENTATION-PLAN M5): a new provider is a new
 * adapter + a registry/composition entry, with ZERO changes to the scheduler,
 * queue, dispatch API, MCP surface, or operator skill. It reuses the same
 * AbstractCliBackend and passes the same conformance suite.
 *
 * Drives `gemini -p --output-format stream-json --approval-mode yolo --skip-trust`
 * (--skip-trust is required: a fresh worktree is not a "trusted folder", which
 * otherwise blocks headless runs). The stream-json event schema is NOT verified
 * live: the gemini CLI on the dev machine cannot authenticate (Google deprecated
 * the free "Gemini Code Assist for individuals" tier), so onEvent/finalize parse
 * defensively and must be confirmed once an authable Gemini (API key) is
 * available. This does not affect the extensibility proof, which is structural:
 * this adapter passes the same conformance suite and nothing above the boundary
 * changed to add it.
 */

import { existsSync, readFileSync } from "node:fs";
import { AbstractCliBackend, type CliEntry } from "../cliBackend.js";
import type { BackendCapabilities, RunResult, RunSpec } from "../../contract/types.js";
import type { ProcessRunner } from "../process/runner.js";

const DEFAULT_MODEL = "gemini-2.5-pro";

function buildPrompt(spec: RunSpec): string {
  const base = existsSync(spec.contextPackageRef)
    ? readFileSync(spec.contextPackageRef, "utf8")
    : `Task ${spec.taskId} (type=${spec.taskType}).\nDeliverables: ${spec.expectedDeliverables.join(", ")}.`;
  // priorReviewFindings arrives pre-labeled (the control plane owns the section
  // headers -- it may carry review findings AND an operator note); append verbatim.
  return spec.priorReviewFindings ? `${base}\n\n${spec.priorReviewFindings}` : base;
}

export class GeminiBackend extends AbstractCliBackend {
  readonly id = "gemini";
  protected readonly cmd = "gemini";

  constructor(runner: ProcessRunner) {
    super(runner);
  }

  capabilities(): BackendCapabilities {
    return {
      supportsResume: false, // gemini --session-file exists but is not wired here yet
      supportsGracefulCancel: false, // cancel is a process kill
      supportsStructuredOutput: false,
      supportsNativeReview: false, // platform dispatches a review task to another worker
      streamsProgress: true,
      isolationModes: ["worktree", "none"],
      maxConcurrentRuns: null,
      reportsCost: false,
      crossRestartRecoverable: false,
    };
  }

  protected buildArgs(spec: RunSpec): string[] {
    const model = spec.modelPreference ?? DEFAULT_MODEL;
    return [
      "-p",
      buildPrompt(spec),
      "-m",
      model,
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
      "--skip-trust", // a fresh worktree is not a trusted folder; required for headless
    ];
  }

  protected resumeArgs(): string[] {
    throw new Error("gemini: resume not supported");
  }

  protected onEvent(entry: CliEntry, event: Record<string, unknown>): void {
    const sid = event["session_id"] ?? event["sessionId"] ?? event["sessionID"];
    if (typeof sid === "string" && !entry.sessionId) entry.sessionId = sid;
    const type = typeof event["type"] === "string" ? (event["type"] as string) : "event";
    entry.progress.push({ at: this.now(), kind: type });
    // Capture a final message defensively from common field shapes.
    const text = event["response"] ?? event["result"] ?? event["content"] ?? event["text"];
    if (typeof text === "string" && text.length > 0) entry.finalMessage = text;
  }

  protected finalize(entry: CliEntry, exitCode: number | null): RunResult {
    if (exitCode === 0) {
      return {
        runId: entry.runId,
        status: "completed",
        ...(entry.finalMessage ? { finalMessage: entry.finalMessage } : {}),
        ...(entry.spec.isolationUnit.mode === "worktree" ? { branchRef: entry.spec.isolationUnit.branch } : {}),
      };
    }
    const stderr = this.stderrTail(entry);
    const signal = this.killSignal(entry);
    return {
      runId: entry.runId,
      status: "errored",
      error: {
        code: "transient",
        message: `gemini exited ${exitCode}${signal ? ` (signal ${signal})` : ""}${stderr ? `; stderr: ${stderr}` : ""}`,
        retryable: true,
      },
      ...(entry.finalMessage ? { finalMessage: entry.finalMessage } : {}),
    };
  }
}
