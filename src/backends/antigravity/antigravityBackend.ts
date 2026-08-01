/**
 * Antigravity backend -- drives Google's `agy` CLI (Antigravity), which fronts a
 * roster (Gemini 3.x, Claude Sonnet/Opus 4.6, GPT-OSS) behind one headless CLI.
 *
 * Unlike Codex/Claude, `agy --print` emits PLAIN TEXT, not JSONL -- so this
 * adapter captures stdout via the onRawLine hook rather than onEvent. That it
 * fits the same Backend contract is a stronger extensibility proof than another
 * JSONL CLI: the contract spans streaming-JSON and plain-text providers alike,
 * with zero changes above the adapter boundary.
 */

import { existsSync, readFileSync } from "node:fs";
import { AbstractCliBackend, type CliEntry } from "../cliBackend.js";
import type { BackendCapabilities, RunResult, RunSpec } from "../../contract/types.js";
import type { ProcessRunner } from "../process/runner.js";

const DEFAULT_MODEL = "Gemini 3.5 Flash (Low)";

function buildPrompt(spec: RunSpec): string {
  const base = existsSync(spec.contextPackageRef)
    ? readFileSync(spec.contextPackageRef, "utf8")
    : `Task ${spec.taskId} (type=${spec.taskType}).\nDeliverables: ${spec.expectedDeliverables.join(", ")}.`;
  // agy is project-oriented (it ignores cwd and defaults to a scratch project),
  // so tell it the worktree explicitly; buildArgs also passes --add-dir for it.
  const dirNote =
    spec.isolationUnit.mode === "worktree"
      ? `Your working directory is ${spec.isolationUnit.path}. Make ALL file changes inside that directory.\n\n`
      : "";
  const body = `${dirNote}${base}`;
  // priorReviewFindings arrives pre-labeled (the control plane owns the section
  // headers -- it may carry review findings AND an operator note); append verbatim.
  return spec.priorReviewFindings ? `${body}\n\n${spec.priorReviewFindings}` : body;
}

export class AntigravityBackend extends AbstractCliBackend {
  readonly id = "antigravity";
  protected readonly cmd = "agy";

  constructor(runner: ProcessRunner) {
    super(runner);
  }

  capabilities(): BackendCapabilities {
    return {
      supportsResume: false, // agy --continue exists but no conversation id is captured from plain text yet
      supportsGracefulCancel: false, // cancel is a process kill
      supportsStructuredOutput: false,
      supportsNativeReview: false, // platform dispatches a review task to another worker
      streamsProgress: false, // --print returns the final response, not incremental events
      isolationModes: ["worktree", "none"],
      maxConcurrentRuns: null,
      reportsCost: false,
      crossRestartRecoverable: false,
    };
  }

  protected buildArgs(spec: RunSpec): string[] {
    const model = spec.modelPreference ?? DEFAULT_MODEL;
    const args = [
      "-p",
      buildPrompt(spec),
      "--model",
      model,
      "--mode",
      "accept-edits", // actually apply file edits
      "--dangerously-skip-permissions", // headless: never block on an approval prompt (sandboxed worktree is the boundary)
      "--print-timeout",
      "600s",
    ];
    // agy operates on its "workspace", not cwd; add the worktree so it edits there.
    if (spec.isolationUnit.mode === "worktree") args.push("--add-dir", spec.isolationUnit.path);
    return args;
  }

  protected resumeArgs(): string[] {
    throw new Error("antigravity: resume not supported");
  }

  protected onEvent(): void {
    // agy emits plain text, not JSONL; nothing to do here (see onRawLine).
  }

  protected override onRawLine(entry: CliEntry, line: string): void {
    entry.finalMessage = entry.finalMessage ? `${entry.finalMessage}\n${line}` : line;
    entry.progress.push({ at: this.now(), kind: "output" });
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
        message: `agy exited ${exitCode}${signal ? ` (signal ${signal})` : ""}${stderr ? `; stderr: ${stderr}` : ""}`,
        retryable: true,
      },
      ...(entry.finalMessage ? { finalMessage: entry.finalMessage } : {}),
    };
  }
}
