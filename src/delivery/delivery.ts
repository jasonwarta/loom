/**
 * Delivery: the platform-side step that gets an accepted run's work OFF the
 * machine -- push the branch and open a pull request.
 *
 * This is deliberately SEPARATE from the worker and from isolation. Delivery is
 * a PLATFORM responsibility: workers are never asked to push or open PRs (even
 * where a worker has network for installs/tests, giving it delivery duties
 * would leak provider mechanics into every backend and put publishing inside
 * the least-trusted component). Instead the platform commits the worktree to
 * its branch (IsolationProvider.commit) and THEN, once review accepts, the
 * platform -- which has gh auth and runs outside any sandbox -- pushes and
 * opens the PR.
 *
 * Wired in the composition root (daemon/index.ts) and invoked by the control
 * plane on the accept path. Optional: omit it and accepted work simply stays on
 * its local branch (the pre-delivery behavior).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IsolationUnit } from "../contract/types.js";

const exec = promisify(execFile);

/** What to put on the pull request. Derived from the task by the control plane. */
export interface DeliveryRequest {
  readonly taskId: string;
  readonly title: string;
  readonly body: string;
  /** Branch the PR merges INTO (the task's base branch). */
  readonly baseBranch: string;
}

export interface DeliveryOutcome {
  /** True if the branch was pushed to the remote. */
  readonly pushed: boolean;
  /** URL of the opened (or pre-existing) pull request, if one was created/found. */
  readonly prUrl?: string;
}

/** Ship an accepted run's branch. Throws on failure; the caller decides how to surface it. */
export interface DeliveryProvider {
  publish(unit: IsolationUnit, req: DeliveryRequest): Promise<DeliveryOutcome>;
}

export interface GitHubDeliveryOptions {
  /** On-disk repo root to run git/gh from (the daemon's checkout, which has a remote + auth). */
  readonly repoRoot: string;
  /** Git remote to push to. Default "origin". */
  readonly remote?: string;
  /** Open the PR as a draft (human gates the merge). Default true. */
  readonly draft?: boolean;
}

/**
 * GitHub delivery via `git push` + `gh pr create`, run from the daemon's own
 * checkout. Idempotent: if a PR already exists for the branch (a recovery re-run),
 * it returns that PR's URL instead of failing.
 */
export class GitHubDelivery implements DeliveryProvider {
  private readonly repoRoot: string;
  private readonly remote: string;
  private readonly draft: boolean;

  constructor(opts: GitHubDeliveryOptions) {
    this.repoRoot = opts.repoRoot;
    this.remote = opts.remote ?? "origin";
    this.draft = opts.draft ?? true;
  }

  async publish(unit: IsolationUnit, req: DeliveryRequest): Promise<DeliveryOutcome> {
    // Only worktree runs produce a branch to ship. mode "none"/"sandbox" have nothing to push.
    if (unit.mode !== "worktree") return { pushed: false };

    await exec("git", ["-C", this.repoRoot, "push", "-u", this.remote, unit.branch]);

    const args = [
      "pr",
      "create",
      "--head",
      unit.branch,
      "--base",
      req.baseBranch,
      "--title",
      req.title,
      "--body",
      req.body,
    ];
    if (this.draft) args.push("--draft");

    try {
      const { stdout } = await exec("gh", args, { cwd: this.repoRoot });
      const prUrl = lastUrl(stdout);
      return { pushed: true, ...(prUrl ? { prUrl } : {}) };
    } catch (err) {
      // A PR may already exist for this branch (recovery re-run). Treat that as
      // success by returning the existing PR's URL; rethrow anything else.
      const existing = await this.existingPrUrl(unit.branch);
      if (existing) return { pushed: true, prUrl: existing };
      throw err;
    }
  }

  private async existingPrUrl(branch: string): Promise<string | undefined> {
    try {
      const { stdout } = await exec("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
        cwd: this.repoRoot,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

/** `gh pr create` prints the PR URL as its final output line. */
function lastUrl(stdout: string): string | undefined {
  const line = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line && line.startsWith("http") ? line : undefined;
}
