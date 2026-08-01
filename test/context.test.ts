import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileContextBuilder, ContextTooLargeError } from "../src/context/contextBuilder.js";
import type { TaskRecord } from "../src/domain/model.js";
import type { WorkerRecord } from "../src/scheduler/registry.js";
import { makeTaskDef } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function taskRec(over: Partial<TaskRecord["definition"]> = {}): TaskRecord {
  return { id: "task-1", definition: makeTaskDef(over), state: "queued", createdAt: 0, updatedAt: 0 };
}
const worker = (contextWindow?: number): WorkerRecord => ({
  workerId: "w",
  backend: "fake",
  model: "m",
  ...(contextWindow !== undefined ? { contextWindow } : {}),
});

describe("FileContextBuilder", () => {
  it("assembles description + acceptance criteria + listed files into a package file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "loom-ctxrepo-"));
    const out = mkdtempSync(join(tmpdir(), "loom-ctxout-"));
    dirs.push(repo, out);
    writeFileSync(join(repo, "a.ts"), "export const answer = 42;\n");

    const builder = new FileContextBuilder({ repoRoot: repo, outDir: out });
    const built = await builder.build(
      taskRec({ description: "Wire the answer", acceptanceCriteria: ["exports answer"], contextFiles: ["a.ts"] }),
      worker(),
    );

    expect(existsSync(built.ref)).toBe(true);
    const text = readFileSync(built.ref, "utf8");
    expect(text).toContain("Wire the answer");
    expect(text).toContain("exports answer");
    expect(text).toContain("export const answer = 42;");
    expect(built.estimatedTokens).toBeGreaterThan(0);
  });

  it("every package carries the autonomy directive (headless: never ask, assume and proceed)", async () => {
    const out = mkdtempSync(join(tmpdir(), "loom-ctxout-"));
    dirs.push(out);
    const builder = new FileContextBuilder({ outDir: out });
    const built = await builder.build(taskRec(), worker());
    const text = readFileSync(built.ref, "utf8");
    expect(text).toContain("Operating mode: AUTONOMOUS");
    expect(text).toContain("NEVER pause for confirmation");
    expect(text).toContain("Assumptions");
  });

  it("throws ContextTooLargeError when the package cannot fit the worker window", async () => {
    const out = mkdtempSync(join(tmpdir(), "loom-ctxout-"));
    dirs.push(out);
    const builder = new FileContextBuilder({ outDir: out });
    const big = "x".repeat(10000); // ~2500 tokens
    await expect(
      builder.build(taskRec({ description: big }), worker(100)), // window 100 -> budget 80
    ).rejects.toBeInstanceOf(ContextTooLargeError);
  });
});
