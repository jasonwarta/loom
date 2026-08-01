/**
 * Worktree isolation (ARCHITECTURE section 21). Each implementation run gets its
 * own git worktree on its own branch so concurrent runs cannot clobber each
 * other's uncommitted work. The platform -- not the backend -- owns this: it
 * creates the worktree, points the backend at it (RunSpec.isolationUnit), and
 * tears the checkout down afterward while keeping the branch (the deliverable).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IsolationUnit } from "../contract/types.js";

const exec = promisify(execFile);

/** Acquire/release an isolation workspace for a run. */
export interface IsolationProvider {
  /**
   * `repo` is the logical RunSpec.repo identifier; the provider maps it to a workspace.
   * When `resumeBranch` is given, the workspace ADOPTS that existing branch (with its
   * prior, possibly-unpushed work) instead of branching fresh from `baseBranch` --
   * this is recovery mode, so a re-run continues where an earlier one stopped.
   */
  acquire(runId: string, repo: string, baseBranch: string, resumeBranch?: string): Promise<IsolationUnit>;
  /**
   * Commit any uncommitted changes in the unit to its branch, so the work
   * survives release and is visible to the reviewer. The platform does this
   * rather than trusting the worker to commit -- uncommitted work is otherwise
   * discarded when the worktree is removed. No-op if there is nothing to commit.
   */
  commit(unit: IsolationUnit, message: string): Promise<void>;
  /**
   * Optional: does the unit's branch hold ANY work beyond `baseBranch` (after
   * commit())? Lets the platform treat a "completed" run that produced nothing
   * as a failed run -- the signature of a worker that stalled or asked a
   * question -- instead of wasting a review on an empty branch. Return true
   * when unknown.
   */
  hasNewWork?(unit: IsolationUnit, baseBranch: string): Promise<boolean>;
  release(unit: IsolationUnit): Promise<void>;
}

export interface WorktreeManagerOptions {
  /** Base directory to hold worktree checkouts. Defaults to a temp dir. */
  readonly baseDir?: string;
  /** Branch name prefix. Defaults to "loom/". */
  readonly branchPrefix?: string;
  /**
   * On-disk path of the repo to create worktrees from. The value passed to
   * acquire() is a LOGICAL repo identifier (RunSpec.repo), not a filesystem
   * path, so a single-repo deployment configures the real path here. When
   * unset, acquire() treats its argument as a path (used by direct tests).
   */
  readonly repoRoot?: string;
}

export class WorktreeManager implements IsolationProvider {
  private readonly baseDir: string;
  private readonly branchPrefix: string;
  private readonly repoRoot: string | undefined;
  /** worktree path -> main repo root, so release() can run git from the main repo. */
  private readonly repoOf = new Map<string, string>();

  constructor(opts: WorktreeManagerOptions = {}) {
    this.baseDir = opts.baseDir ?? join(tmpdir(), "loom-worktrees");
    this.branchPrefix = opts.branchPrefix ?? "loom/";
    this.repoRoot = opts.repoRoot;
  }

  async acquire(runId: string, repo: string, baseBranch: string, resumeBranch?: string): Promise<IsolationUnit> {
    // Prefer the configured on-disk root; fall back to treating `repo` as a path.
    const repoRoot = this.repoRoot ?? repo;
    const path = join(this.baseDir, runId);
    if (resumeBranch) {
      // Recovery mode: check out an EXISTING branch (no -b) so the run continues
      // prior work. Prune first -- a previous run's checkout was reaped by
      // release() but its worktree registration may linger and would otherwise
      // make git refuse to check the branch out again ("already used by worktree").
      await exec("git", ["-C", repoRoot, "worktree", "prune"]);
      await exec("git", ["-C", repoRoot, "worktree", "add", path, resumeBranch]);
      this.repoOf.set(path, repoRoot);
      return { mode: "worktree", path, branch: resumeBranch };
    }
    const branch = `${this.branchPrefix}${runId}`;
    await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, baseBranch]);
    this.repoOf.set(path, repoRoot);
    return { mode: "worktree", path, branch };
  }

  async commit(unit: IsolationUnit, message: string): Promise<void> {
    if (unit.mode !== "worktree") return;
    await exec("git", ["-C", unit.path, "add", "-A"]);
    const status = await exec("git", ["-C", unit.path, "status", "--porcelain"]);
    if (status.stdout.trim().length === 0) return; // nothing to commit
    // Inline identity so the commit never fails on a repo without user config,
    // and commit.gpgsign=false so it never fails on a repo that requires signing:
    // this is a mechanical bot commit in a headless worker (no tty/pinentry, and
    // no reason to sign with the operator's key). Without this, a signing-enabled
    // repo makes commit() throw, the run errors, release() reaps the checkout, and
    // the worker's work is silently lost.
    await exec("git", [
      "-C",
      unit.path,
      "-c",
      "user.email=loom@localhost",
      "-c",
      "user.name=Loom",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      message,
    ]);
  }

  async hasNewWork(unit: IsolationUnit, baseBranch: string): Promise<boolean> {
    if (unit.mode !== "worktree") return true;
    try {
      const { stdout } = await exec("git", ["-C", unit.path, "rev-list", "--count", `${baseBranch}..HEAD`]);
      return Number(stdout.trim()) > 0;
    } catch {
      return true; // cannot tell -> do not block the pipeline on the guard
    }
  }

  async release(unit: IsolationUnit): Promise<void> {
    if (unit.mode !== "worktree") return;
    const repoRoot = this.repoOf.get(unit.path);
    if (!repoRoot || !existsSync(unit.path)) {
      this.repoOf.delete(unit.path);
      return;
    }
    // Remove the checkout (force: it may hold uncommitted scratch); keep the
    // branch -- committed work on it is the deliverable.
    try {
      await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", unit.path]);
    } catch {
      try {
        await exec("git", ["-C", repoRoot, "worktree", "prune"]);
      } catch {
        // a stale worktree entry is not fatal to the run's result
      }
    }
    this.repoOf.delete(unit.path);
  }
}
