/**
 * Gated LIVE smoke test. Runs the REAL codex and claude CLIs on a scratch git
 * repo, in isolated worktrees, through the full control plane. It costs tokens
 * and makes real model calls, so it is skipped unless LOOM_LIVE=1.
 *
 *   LOOM_LIVE=1 npx vitest run test/live.test.ts
 *
 * By default it exercises both backends; set LOOM_LIVE_BACKENDS=codex or
 * =claude to run just one.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveLoom } from "../src/daemon/index.js";
import { makeTaskDef } from "./helpers.js";

const LIVE = process.env.LOOM_LIVE === "1";
const which = process.env.LOOM_LIVE_BACKENDS ?? "codex,claude";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-live-repo-"));
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("config", "user.email", "loom@example.com");
  git("config", "user.name", "Loom");
  writeFileSync(join(dir, "README.md"), "scratch repo for loom live smoke test\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

const registryYaml = `
workers:
  - workerId: w-codex
    backend: codex
    model: gpt-5.4-mini
    availability: available
    contextWindow: 400000
  - workerId: w-claude
    backend: claude
    model: claude-sonnet-5
    availability: available
    contextWindow: 1000000
`;

describe.skipIf(!LIVE)("LIVE backends smoke", () => {
  for (const backend of which.split(",")) {
    const workerId = backend === "codex" ? "w-codex" : "w-claude";

    it(
      `runs a real task on ${backend} and completes`,
      async () => {
        const repo = initRepo();
        const dbPath = join(repo, "loom.sqlite");
        const registryPath = join(repo, "registry.yaml");
        const wtBase = mkdtempSync(join(tmpdir(), "loom-live-wt-"));
        writeFileSync(registryPath, registryYaml);

        const loom = createLiveLoom({
          dbPath,
          registryPath,
          repoRoot: repo,
          worktreeBaseDir: wtBase,
          dispatch: { pollDelayMs: 1500 },
        });
        try {
          const taskId = loom.controlPlane.dispatchWorker({
            definition: makeTaskDef({
              taskType: "implementation",
              description:
                "Create a file named loom-hello.txt in the repository root containing exactly the line: hello from loom",
              acceptanceCriteria: ["loom-hello.txt exists with the required line"],
              wallClockMs: 540000,
            }),
            preferredWorkerId: workerId,
          });

          await loom.controlPlane.drain({ concurrency: 1 });

          const view = loom.controlPlane.getResult(taskId)!;
          // Strict: the run must actually COMPLETE through the whole pipeline.
          // (A lenient completed-or-failed check previously masked a broken
          // arg list that made codex exit 2 instantly.)
          expect(view.task.state).toBe("completed");
          expect(view.runs).toHaveLength(1);
          expect(view.runs[0]!.state).toBe("completed");
          // A worktree + branch were created for the run.
          expect(view.runs[0]!.runSpec.isolationUnit.mode).toBe("worktree");
          expect(view.runs[0]!.runSpec.isolationUnit).toMatchObject({ mode: "worktree" });
        } finally {
          loom.close();
          rmSync(repo, { recursive: true, force: true });
          rmSync(wtBase, { recursive: true, force: true });
          if (existsSync(wtBase)) rmSync(wtBase, { recursive: true, force: true });
        }
      },
      600000,
    );
  }
});
