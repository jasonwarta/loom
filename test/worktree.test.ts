import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../src/isolation/worktree.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-repo-"));
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

describe("WorktreeManager (real git)", () => {
  it("creates an isolated worktree + branch, then releases the checkout but keeps the branch", async () => {
    const repo = initRepo();
    const baseDir = mkdtempSync(join(tmpdir(), "loom-wt-"));
    const mgr = new WorktreeManager({ baseDir });
    try {
      const unit = await mgr.acquire("run-x", repo, "main");
      expect(unit.mode).toBe("worktree");
      if (unit.mode !== "worktree") return;

      expect(existsSync(unit.path)).toBe(true);
      expect(unit.branch).toBe("loom/run-x");
      const branches = execFileSync("git", ["-C", repo, "branch", "--list", "loom/run-x"], { encoding: "utf8" });
      expect(branches).toContain("loom/run-x");

      await mgr.release(unit);
      expect(existsSync(unit.path)).toBe(false); // checkout gone
      const after = execFileSync("git", ["-C", repo, "branch", "--list", "loom/run-x"], { encoding: "utf8" });
      expect(after).toContain("loom/run-x"); // branch (the deliverable) persists
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("release on a mode:none unit is a no-op", async () => {
    const mgr = new WorktreeManager();
    await mgr.release({ mode: "none" });
  });

  it("commits worker output even when the repo REQUIRES gpg signing", async () => {
    // Regression: overnight runs on a signing-enabled repo lost all work because
    // the platform commit failed to sign (no tty/pinentry) and the checkout was
    // then reaped. commit() must force commit.gpgsign=false so bot commits land.
    const repo = initRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", "/bin/false"); // any signing attempt would fail hard
    const baseDir = mkdtempSync(join(tmpdir(), "loom-wt-"));
    const mgr = new WorktreeManager({ baseDir });
    try {
      const unit = await mgr.acquire("run-sign", repo, "main");
      if (unit.mode !== "worktree") throw new Error("expected worktree");
      writeFileSync(join(unit.path, "work.txt"), "worker result\n");
      await mgr.commit(unit, "loom: work"); // must NOT throw despite signing config
      const log = execFileSync("git", ["-C", repo, "log", "loom/run-sign", "--oneline"], { encoding: "utf8" });
      expect(log).toContain("loom: work"); // the work landed on the branch
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("hasNewWork: false on a fresh untouched branch, true once work is committed", async () => {
    const repo = initRepo();
    const baseDir = mkdtempSync(join(tmpdir(), "loom-wt-"));
    const mgr = new WorktreeManager({ baseDir });
    try {
      const unit = await mgr.acquire("run-e", repo, "main");
      if (unit.mode !== "worktree") throw new Error("expected worktree");
      // Nothing done yet: branch == main -> no new work (the empty-run signature).
      expect(await mgr.hasNewWork(unit, "main")).toBe(false);
      writeFileSync(join(unit.path, "work.txt"), "real output\n");
      await mgr.commit(unit, "loom: work");
      expect(await mgr.hasNewWork(unit, "main")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("recovery mode: adopts an EXISTING branch instead of branching from base", async () => {
    const repo = initRepo();
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    // Prior work lives on feature/x, not on main.
    git("checkout", "-b", "feature/x");
    writeFileSync(join(repo, "prior.txt"), "unfinished work\n");
    git("add", ".");
    git("commit", "-m", "prior work");
    git("checkout", "main"); // leave feature/x free to be checked out into a worktree
    const baseDir = mkdtempSync(join(tmpdir(), "loom-wt-"));
    const mgr = new WorktreeManager({ baseDir });
    try {
      const unit = await mgr.acquire("run-r", repo, "main", "feature/x");
      if (unit.mode !== "worktree") throw new Error("expected worktree");
      expect(unit.branch).toBe("feature/x"); // adopted, not a fresh loom/run-r branch
      expect(existsSync(join(unit.path, "prior.txt"))).toBe(true); // prior work is present
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
