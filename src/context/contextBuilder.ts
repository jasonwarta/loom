/**
 * Context Builder v1 (ARCHITECTURE section 14). Produces the minimal sufficient
 * context package for a run and returns a reference (a file path) rather than
 * inlining content into the RunSpec.
 *
 * v1 composes task-declared inputs (description + acceptance criteria) and
 * explicitly listed files, and enforces the context-window budget: if the
 * package cannot fit the target worker's window, it raises ContextTooLargeError
 * so the platform can escalate ("decompose further") instead of dispatching a
 * doomed run. Code-graph / RAG retrieval are pluggable strategies not yet wired
 * (the interface is the seam for them).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskRecord } from "../domain/model.js";
import type { WorkerRecord } from "../scheduler/registry.js";
import { scrubSecrets } from "./scrub.js";

export class ContextTooLargeError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly budgetTokens: number,
  ) {
    super(`context package ~${estimatedTokens} tokens exceeds worker budget ${budgetTokens}`);
    this.name = "ContextTooLargeError";
  }
}

export interface BuiltContext {
  readonly ref: string;
  readonly estimatedTokens: number;
}

export interface ContextBuildOptions {
  /**
   * Effective branch this run resumes: recovery mode (definition-level) OR a
   * revision run continuing the prior attempt's branch (platform-decided).
   * Overrides the task definition's `resumeFromBranch`.
   */
  readonly resumeBranch?: string;
}

export interface ContextBuilder {
  build(task: TaskRecord, worker: WorkerRecord, opts?: ContextBuildOptions): Promise<BuiltContext>;
}

export interface FileContextBuilderOptions {
  readonly outDir?: string;
  /** Repo root used to resolve TaskDefinition.contextFiles. Defaults to cwd. */
  readonly repoRoot?: string;
  /** Fraction of the worker's context window to keep free. Default 0.2. */
  readonly headroom?: number;
}

/** Rough token estimate: ~4 chars/token. Good enough for a budget gate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Every worker run is headless: a worker that pauses to ask a question burns
 * its whole budget and delivers nothing (a real run once burned its whole budget doing
 * exactly that). This directive is part of EVERY context package the platform
 * builds -- it is platform policy, not per-task prose.
 */
const AUTONOMY_DIRECTIVE = [
  `## Operating mode: AUTONOMOUS`,
  `You are running headless inside an orchestration platform. There is NO human`,
  `and NO orchestrator watching this session -- a question asked here is read by`,
  `no one, and a run that stops to ask delivers nothing and wastes its entire budget.`,
  `- NEVER pause for confirmation, clarification, or approval. Asking is failing.`,
  `- At any ambiguity or decision point: choose the most reasonable option`,
  `  consistent with the acceptance criteria, and proceed.`,
  `- Record every such choice in your final summary under an "Assumptions" heading`,
  `  -- an independent reviewer will judge them.`,
  `- You MAY run commands (tests, builds, git) inside your workspace; services`,
  `  like databases are available on localhost where the task requires them.`,
  `  Run the task's checks yourself before declaring the work complete.`,
  `- Only if the task is genuinely impossible as specified, end your run with a`,
  `  final message starting "IMPOSSIBLE:" and the precise reason.`,
].join("\n");

export class FileContextBuilder implements ContextBuilder {
  private readonly outDir: string;
  private readonly repoRoot: string;
  private readonly headroom: number;

  constructor(opts: FileContextBuilderOptions = {}) {
    this.outDir = opts.outDir ?? join(tmpdir(), "loom-context");
    this.repoRoot = opts.repoRoot ?? process.cwd();
    this.headroom = opts.headroom ?? 0.2;
  }

  async build(task: TaskRecord, worker: WorkerRecord, opts?: ContextBuildOptions): Promise<BuiltContext> {
    const d = task.definition;
    const parts: string[] = [
      `# Task ${task.id}`,
      `Type: ${d.taskType}`,
      AUTONOMY_DIRECTIVE,
      `## Description\n${d.description}`,
      `## Acceptance criteria\n${d.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    ];

    const resumeBranch = opts?.resumeBranch ?? d.resumeFromBranch;
    if (resumeBranch !== undefined) {
      parts.push(
        `## Recovery: prior work exists\n` +
          `This is NOT a blank slate. Your working directory is already checked out on ` +
          `branch \`${resumeBranch}\`, which holds unfinished work from an earlier run. ` +
          `First assess what is already there (\`git log ${d.baseBranch}..HEAD\` and ` +
          `\`git diff ${d.baseBranch}...HEAD\`), then CONTINUE that work to satisfy the acceptance ` +
          `criteria. Do not restart from scratch or discard the existing commits.`,
      );
    }

    for (const rel of d.contextFiles ?? []) {
      const abs = resolve(this.repoRoot, rel);
      if (existsSync(abs)) {
        parts.push(`## File: ${rel}\n\`\`\`\n${readFileSync(abs, "utf8")}\n\`\`\``);
      } else {
        parts.push(`## File: ${rel}\n(not found)`);
      }
    }

    // Redact secrets before the package leaves the platform (may go to a remote model).
    const text = scrubSecrets(parts.join("\n\n"));
    const estimatedTokens = estimateTokens(text);

    if (worker.contextWindow !== undefined) {
      const budget = Math.floor(worker.contextWindow * (1 - this.headroom));
      if (estimatedTokens > budget) throw new ContextTooLargeError(estimatedTokens, budget);
    }

    mkdirSync(this.outDir, { recursive: true });
    const ref = join(this.outDir, `ctx-${task.id}-${randomUUID().slice(0, 8)}.md`);
    writeFileSync(ref, text, "utf8");
    return { ref, estimatedTokens };
  }
}
