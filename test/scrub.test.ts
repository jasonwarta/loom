import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "../src/context/scrub.js";
import { FileContextBuilder } from "../src/context/contextBuilder.js";
import type { TaskRecord } from "../src/domain/model.js";
import type { WorkerRecord } from "../src/scheduler/registry.js";
import { makeTaskDef } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scrubSecrets", () => {
  it("redacts provider keys, cloud keys, and env-style secrets; keeps ordinary text", () => {
    const input = [
      "const OPENAI_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz012345'",
      "gh token: ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD",
      "aws: AKIAIOSFODNN7EXAMPLE",
      "DB_PASSWORD=hunter2secret",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "This is a normal sentence about the task.",
    ].join("\n");
    const out = scrubSecrets(input);

    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("hunter2secret");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("This is a normal sentence about the task.");
    // Keeps the key name for the env-style assignment, redacts only the value.
    expect(out).toContain("DB_PASSWORD");
  });

  it("redacts PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(pem)).toBe("[REDACTED PRIVATE KEY]");
  });
});

describe("context builder scrubs secrets in the package", () => {
  it("does not write a secret from a context file into the package", async () => {
    const repo = mkdtempSync(join(tmpdir(), "loom-scrubrepo-"));
    const out = mkdtempSync(join(tmpdir(), "loom-scrubout-"));
    dirs.push(repo, out);
    writeFileSync(join(repo, "config.ts"), "export const KEY = 'sk-secretsecretsecretsecretsecret12';\n");

    const builder = new FileContextBuilder({ repoRoot: repo, outDir: out });
    const task: TaskRecord = {
      id: "t1",
      definition: makeTaskDef({ contextFiles: ["config.ts"] }),
      state: "queued",
      createdAt: 0,
      updatedAt: 0,
    };
    const worker: WorkerRecord = { workerId: "w", backend: "fake", model: "m" };
    const built = await builder.build(task, worker);

    const pkg = readFileSync(built.ref, "utf8");
    expect(pkg).not.toContain("sk-secretsecretsecretsecretsecret12");
    expect(pkg).toContain("[REDACTED]");
  });
});
