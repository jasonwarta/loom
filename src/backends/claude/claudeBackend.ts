/**
 * Claude backend -- drives `claude -p --output-format stream-json` behind the
 * Backend contract. In a standalone daemon there is no in-process Agent tool,
 * so Claude is reached as a subprocess on the machine's Claude Code auth --
 * co-first-class with Codex, same contract, different CLI. (This corrects the
 * architecture's "in-process" framing; see docs/ARCHITECTURE.md 9.2.)
 *
 * Final message, status, session id, and cost are read from the stream-json
 * `result` event. The exact event schema is confirmed/adjusted by the gated
 * live smoke test; onEvent parses defensively.
 */

import { existsSync, readFileSync } from "node:fs";
import { AbstractCliBackend, type CliEntry } from "../cliBackend.js";
import type { BackendCapabilities, RunResult, RunSpec, Usage } from "../../contract/types.js";
import type { ProcessRunner } from "../process/runner.js";

const DEFAULT_MODEL = "claude-sonnet-5";

function buildPrompt(spec: RunSpec): string {
  const base = existsSync(spec.contextPackageRef)
    ? readFileSync(spec.contextPackageRef, "utf8")
    : `Task ${spec.taskId} (type=${spec.taskType}).\nDeliverables: ${spec.expectedDeliverables.join(", ")}.`;
  // priorReviewFindings arrives pre-labeled (the control plane owns the section
  // headers -- it may carry review findings AND an operator note); append verbatim.
  return spec.priorReviewFindings ? `${base}\n\n${spec.priorReviewFindings}` : base;
}

/**
 * Permission flags for headless `claude -p`. Headless runs cannot answer
 * permission prompts, and `acceptEdits` alone auto-approves only file edits --
 * Bash would be silently DENIED, leaving the worker unable to run tests,
 * builds, or git. So implementation runs explicitly allow Bash; read-only runs
 * (dispatched reviews) get only read-only git inspection commands and no edit
 * auto-approval.
 */
function permissionArgs(spec: RunSpec): string[] {
  if (spec.isolationPolicy.writeScope === "read-only") {
    return [
      "--allowedTools",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git status:*)",
    ];
  }
  return ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"];
}

export class ClaudeBackend extends AbstractCliBackend {
  readonly id = "claude";
  protected readonly cmd = "claude";

  constructor(runner: ProcessRunner) {
    super(runner);
  }

  capabilities(): BackendCapabilities {
    return {
      supportsResume: true,
      supportsGracefulCancel: false,
      supportsStructuredOutput: false, // no enforced output schema in headless mode
      supportsNativeReview: false, // platform dispatches a review task to another worker
      streamsProgress: true,
      isolationModes: ["worktree", "none"],
      maxConcurrentRuns: null,
      reportsCost: true, // total_cost_usd is in the result event
      crossRestartRecoverable: false,
    };
  }

  protected buildArgs(spec: RunSpec): string[] {
    const model = spec.modelPreference ?? DEFAULT_MODEL;
    return [
      "-p",
      buildPrompt(spec),
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      ...permissionArgs(spec),
    ];
  }

  protected resumeArgs(entry: CliEntry, addendum?: string): string[] {
    const model = entry.spec.modelPreference ?? DEFAULT_MODEL;
    const base: string[] = [];
    if (entry.sessionId) base.push("--resume", entry.sessionId);
    base.push(
      "-p",
      addendum ?? "continue",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
      ...permissionArgs(entry.spec),
    );
    return base;
  }

  protected onEvent(entry: CliEntry, event: Record<string, unknown>): void {
    const sid = event["session_id"] ?? event["sessionId"];
    if (typeof sid === "string" && !entry.sessionId) entry.sessionId = sid;
    const type = typeof event["type"] === "string" ? (event["type"] as string) : "event";
    entry.progress.push({ at: this.now(), kind: type });

    if (type === "result") {
      const result = event["result"];
      if (typeof result === "string") entry.finalMessage = result;
      entry.data["subtype"] = event["subtype"];
      entry.data["isError"] = event["is_error"];
      const cost = event["total_cost_usd"];
      if (typeof cost === "number") entry.data["costUsd"] = cost;
    }
  }

  protected finalize(entry: CliEntry, exitCode: number | null): RunResult {
    const subtype = entry.data["subtype"];
    const isError = entry.data["isError"] === true || (typeof subtype === "string" && subtype !== "success");
    const costUsd = typeof entry.data["costUsd"] === "number" ? (entry.data["costUsd"] as number) : undefined;
    const usage: Usage | undefined = costUsd !== undefined ? { costUsd } : undefined;

    if (exitCode === 0 && !isError) {
      return {
        runId: entry.runId,
        status: "completed",
        ...(entry.finalMessage ? { finalMessage: entry.finalMessage } : {}),
        ...(entry.spec.isolationUnit.mode === "worktree" ? { branchRef: entry.spec.isolationUnit.branch } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    const stderr = this.stderrTail(entry);
    const signal = this.killSignal(entry);
    return {
      runId: entry.runId,
      status: "errored",
      error: {
        code: "transient",
        message: `claude exited ${exitCode}${signal ? ` (signal ${signal})` : ""} (subtype=${String(subtype)})${stderr ? `; stderr: ${stderr}` : ""}`,
        retryable: true,
      },
      ...(entry.finalMessage ? { finalMessage: entry.finalMessage } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
