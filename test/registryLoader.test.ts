import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { loadRegistry, loadWorkers } from "../src/scheduler/registryLoader.js";
import { Registry } from "../src/scheduler/registry.js";
import { tmpPath } from "./helpers.js";

const files: string[] = [];
afterEach(() => {
  for (const f of files.splice(0)) rmSync(f, { force: true });
});

const YAML = `
workers:
  - workerId: sol
    backend: codex
    model: gpt-5.6-sol
    availability: available
    preferredTaskTypes: [architecture, review]
  - workerId: sonnet
    backend: claude-subagent
    model: claude-sonnet-5
    availability: available
`;

describe("registry YAML loading", () => {
  it("loads a declarative worker list from YAML", () => {
    const path = tmpPath("yaml");
    files.push(path);
    writeFileSync(path, YAML);

    const registry = loadRegistry(path);
    expect(registry.list().map((w) => w.workerId).sort()).toEqual(["sol", "sonnet"]);
    expect(registry.get("sol")?.backend).toBe("codex");
    expect(registry.get("sol")?.preferredTaskTypes).toContain("architecture");
  });

  it("replaceAll swaps the worker set (hot-reload primitive)", () => {
    const path = tmpPath("yaml");
    files.push(path);
    writeFileSync(path, YAML);
    const registry = new Registry();
    registry.replaceAll(loadWorkers(path));
    expect(registry.list()).toHaveLength(2);
    registry.replaceAll([]);
    expect(registry.list()).toHaveLength(0);
  });

  it("rejects a file with no workers array", () => {
    const path = tmpPath("yaml");
    files.push(path);
    writeFileSync(path, "nope: true\n");
    expect(() => loadRegistry(path)).toThrow(/workers/);
  });
});
