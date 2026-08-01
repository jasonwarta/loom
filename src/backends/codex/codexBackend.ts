/**
 * Codex backend -- drives `codex exec` (CLI 0.144.1) behind the Backend
 * contract. All Codex specifics live here and nowhere else.
 *
 * Result capture uses the documented, robust `-o/--output-last-message` file
 * (final assistant message) plus the process exit code for status; the `--json`
 * event stream is used for the session id + progress. The exact `--json` event
 * schema was not verified live during design, so onEvent parses defensively and
 * the field names are confirmed/adjusted by the gated live smoke test.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbstractCliBackend, type CliEntry } from "../cliBackend.js";
import type { BackendCapabilities, RunResult, RunSpec } from "../../contract/types.js";
import type { ProcessRunner } from "../process/runner.js";

const DEFAULT_MODEL = "gpt-5.6-sol";

function outFileFor(runId: string): string {
  return join(tmpdir(), `loom-codex-${runId}.txt`);
}

/** Build the prompt: a resolved context-package file if present, else a synthesized brief. */
function buildPrompt(spec: RunSpec): string {
  const base = existsSync(spec.contextPackageRef)
    ? readFileSync(spec.contextPackageRef, "utf8")
    : `Task ${spec.taskId} (type=${spec.taskType}).\nDeliverables: ${spec.expectedDeliverables.join(", ")}.`;
  // priorReviewFindings arrives pre-labeled (the control plane owns the section
  // headers -- it may carry review findings AND an operator note); append verbatim.
  return spec.priorReviewFindings ? `${base}\n\n${spec.priorReviewFindings}` : base;
}

export class CodexBackend extends AbstractCliBackend {
  readonly id = "codex";
  protected readonly cmd = "codex";

  constructor(runner: ProcessRunner) {
    super(runner);
  }

  capabilities(): BackendCapabilities {
    return {
      supportsResume: true,
      supportsGracefulCancel: false, // exec mode: cancel is a process kill
      supportsStructuredOutput: true, // --output-schema
      // `codex review` exists but is not wired into this adapter yet; until it is,
      // declare false so the platform uses a dispatched review run (honest capability).
      supportsNativeReview: false,
      streamsProgress: true,
      isolationModes: ["worktree", "none"],
      maxConcurrentRuns: null,
      reportsCost: false, // M1 does not parse usage from the event stream yet
      crossRestartRecoverable: false, // exec child does not survive a daemon restart
    };
  }

  protected buildArgs(spec: RunSpec): string[] {
    const model = spec.modelPreference ?? DEFAULT_MODEL;
    // Note: `codex exec` does NOT accept -a/--ask-for-approval (that is a
    // top-level `codex` flag). A daemon cannot answer prompts, so approval is
    // disabled via config override; the sandbox is the safety boundary (never
    // danger-full-access). Read-only runs (dispatched reviews) get the
    // read-only sandbox so a reviewer cannot mutate the checkout it inspects.
    // See ARCHITECTURE section 9.1/22.
    const readOnly = spec.isolationPolicy.writeScope === "read-only";
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m",
      model,
      "-s",
      readOnly ? "read-only" : "workspace-write",
      "-c",
      "approval_policy=never",
    ];
    // Implementation runs need network INSIDE the sandbox: package installs
    // (`yarn install`) and tests against local services (docker Postgres on
    // localhost) are how a worker exercises executable acceptance criteria.
    // The workspace-write sandbox blocks network by default, which left the
    // strongest builder unable to run anything. Filesystem scope stays
    // workspace-write; reviews stay read-only with no network.
    if (!readOnly) args.push("-c", "sandbox_workspace_write.network_access=true");
    args.push("-o", outFileFor(spec.runId), buildPrompt(spec));
    return args;
  }

  protected resumeArgs(entry: CliEntry, addendum?: string): string[] {
    const model = entry.spec.modelPreference ?? DEFAULT_MODEL;
    const base = ["exec", "resume"];
    if (entry.sessionId) base.push(entry.sessionId);
    base.push("--json", "-m", model, "-o", outFileFor(entry.runId));
    base.push(addendum ?? "continue");
    return base;
  }

  protected onEvent(entry: CliEntry, event: Record<string, unknown>): void {
    // Verified against codex 0.144.1 `exec --json`: the first event is
    // {type:"thread.started", thread_id:"..."}. The id field is thread_id.
    const sid = event["thread_id"] ?? event["session_id"] ?? event["sessionId"];
    if (typeof sid === "string" && !entry.sessionId) entry.sessionId = sid;
    const type = typeof event["type"] === "string" ? (event["type"] as string) : "event";
    entry.progress.push({ at: this.now(), kind: type });
  }

  protected finalize(entry: CliEntry, exitCode: number | null): RunResult {
    const outFile = outFileFor(entry.runId);
    const finalMessage = existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : undefined;
    if (exitCode === 0) {
      return {
        runId: entry.runId,
        status: "completed",
        ...(finalMessage ? { finalMessage } : {}),
        ...(entry.spec.isolationUnit.mode === "worktree" ? { branchRef: entry.spec.isolationUnit.branch } : {}),
      };
    }
    const stderr = this.stderrTail(entry);
    const signal = this.killSignal(entry);
    return {
      runId: entry.runId,
      status: "errored",
      error: {
        code: "dispatch_failed",
        message: `codex exec exited ${exitCode}${signal ? ` (signal ${signal})` : ""}${stderr ? `; stderr: ${stderr}` : ""}`,
        retryable: true,
      },
      ...(finalMessage ? { finalMessage } : {}),
    };
  }
}
