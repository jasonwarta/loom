/**
 * Dependency-direction guard. This encodes the prime directive as an executable
 * rule: the layers above the adapter boundary must speak ONLY the contract, so
 * that adding/swapping a backend never forces a change outside the adapter +
 * the composition root (ARCHITECTURE sections 9, 26; IMPLEMENTATION-PLAN M0
 * acceptance: "no provider SDK imported above the adapter boundary").
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SRC, f));
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re = /(?:from|import)\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) specs.push(m[1]!);
  return specs;
}

function layerOf(file: string): string {
  const rel = relative(SRC, file).replace(/\\/g, "/");
  return rel.split("/")[0]!;
}

describe("architecture: dependency direction", () => {
  const files = sourceFiles();

  it("only the composition root and adapters may import a concrete backend", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const layer = layerOf(file);
      if (layer === "backends" || layer === "daemon") continue;
      for (const spec of importsOf(file)) {
        if (spec.includes("backends/")) {
          offenders.push(`${relative(SRC, file)} imports concrete backend '${spec}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the persistence layer may import the sqlite driver", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (layerOf(file) === "persistence") continue;
      for (const spec of importsOf(file)) {
        if (spec === "better-sqlite3") {
          offenders.push(`${relative(SRC, file)} imports 'better-sqlite3' outside persistence`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the contract layer depends on nothing else in the tree (it is the base)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (layerOf(file) !== "contract") continue;
      for (const spec of importsOf(file)) {
        // Contract may only import within itself (./...) and node built-ins.
        if (spec.startsWith("../")) {
          offenders.push(`${relative(SRC, file)} reaches outside contract via '${spec}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scheduler does not import the dispatcher, daemon, or persistence", () => {
    const forbidden = ["dispatcher/", "daemon/", "persistence/"];
    const offenders: string[] = [];
    for (const file of files) {
      if (layerOf(file) !== "scheduler") continue;
      for (const spec of importsOf(file)) {
        if (forbidden.some((f) => spec.includes(f))) {
          offenders.push(`${relative(SRC, file)} imports '${spec}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
