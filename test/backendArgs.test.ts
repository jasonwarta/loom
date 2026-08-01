/**
 * Backend invocation args for the headless-permissions + read-only-review
 * fixes: Claude workers must be able to run commands (Bash is denied headlessly
 * without --allowedTools), reviewers must be read-only, and a run with no
 * worktree must execute in the task's repo, not the daemon's cwd.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { ClaudeBackend } from "../src/backends/claude/claudeBackend.js";
import { CodexBackend } from "../src/backends/codex/codexBackend.js";
import { FakeProcessRunner } from "../src/backends/process/fakeRunner.js";
import type { ProcSpec } from "../src/backends/process/runner.js";
import { makeRunSpec } from "./helpers.js";

function recordingRunner(): { runner: FakeProcessRunner; seen: ProcSpec[] } {
  const seen: ProcSpec[] = [];
  const runner = new FakeProcessRunner((proc) => {
    seen.push(proc);
    return { lines: [], exitCode: 0 };
  });
  return { runner, seen };
}

describe("claude headless permissions", () => {
  it("implementation runs allow Bash and auto-accept edits (headless -p cannot prompt)", async () => {
    const { runner, seen } = recordingRunner();
    const be = new ClaudeBackend(runner);
    await be.dispatch(makeRunSpec({ isolationPolicy: { writeScope: "workspace", networkEgress: "none" } }));
    const args = seen[0]!.args;
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Bash");
  });

  it("read-only (review) runs get git-inspection tools only, and no edit auto-approval", async () => {
    const { runner, seen } = recordingRunner();
    const be = new ClaudeBackend(runner);
    await be.dispatch(
      makeRunSpec({ taskType: "review", isolationPolicy: { writeScope: "read-only", networkEgress: "none" } }),
    );
    const args = seen[0]!.args;
    expect(args).not.toContain("acceptEdits");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("Bash(git diff:*)");
    expect(args).toContain("Bash(git log:*)");
    expect(args).not.toContain("Bash"); // no blanket Bash for a reviewer
  });
});

describe("codex sandbox by write scope", () => {
  it("implementation runs use workspace-write; read-only runs use read-only", async () => {
    const { runner, seen } = recordingRunner();
    const be = new CodexBackend(runner);
    await be.dispatch(makeRunSpec({ isolationPolicy: { writeScope: "workspace", networkEgress: "none" } }));
    await be.dispatch(
      makeRunSpec({ taskType: "review", isolationPolicy: { writeScope: "read-only", networkEgress: "none" } }),
    );
    const sandboxOf = (p: ProcSpec) => p.args[p.args.indexOf("-s") + 1];
    expect(sandboxOf(seen[0]!)).toBe("workspace-write");
    expect(sandboxOf(seen[1]!)).toBe("read-only");
  });

  it("implementation runs get in-sandbox network (installs + local docker tests); reviews don't", async () => {
    const { runner, seen } = recordingRunner();
    const be = new CodexBackend(runner);
    await be.dispatch(makeRunSpec({ isolationPolicy: { writeScope: "workspace", networkEgress: "none" } }));
    await be.dispatch(
      makeRunSpec({ taskType: "review", isolationPolicy: { writeScope: "read-only", networkEgress: "none" } }),
    );
    expect(seen[0]!.args).toContain("sandbox_workspace_write.network_access=true");
    expect(seen[1]!.args).not.toContain("sandbox_workspace_write.network_access=true");
  });
});

describe("errored runs carry stderr", () => {
  it("a CLI that dies on startup surfaces its stderr in the run error", async () => {
    const seenSpecs: ProcSpec[] = [];
    const runner = new FakeProcessRunner((proc) => {
      seenSpecs.push(proc);
      return { lines: [], exitCode: 1, stderr: "Error: invalid API key\n(see ~/.claude for auth)" };
    });
    const be = new ClaudeBackend(runner);
    const handle = await be.dispatch(makeRunSpec());
    // Wait for the background consumer to reach a terminal phase.
    for (let i = 0; i < 100; i++) {
      const status = await be.poll(handle);
      if (status.phase === "errored") break;
      await new Promise((r) => setTimeout(r, 1));
    }
    const result = await be.result(handle);
    expect(result.status).toBe("errored");
    expect(result.error?.message).toContain("invalid API key");
  });
});

describe("cwd resolution", () => {
  it("uses the worktree when there is one, else the task repo when it is a real directory", async () => {
    const { runner, seen } = recordingRunner();
    const be = new ClaudeBackend(runner);
    await be.dispatch(
      makeRunSpec({ isolationUnit: { mode: "worktree", path: "/fake/wt", branch: "loom/x" } }),
    );
    await be.dispatch(makeRunSpec({ repo: tmpdir() })); // isolation none, real dir
    await be.dispatch(makeRunSpec({ repo: "not-a-real-path" })); // isolation none, not a dir
    expect(seen[0]!.cwd).toBe("/fake/wt");
    expect(seen[1]!.cwd).toBe(tmpdir());
    expect(seen[2]!.cwd).toBeUndefined();
  });
});
