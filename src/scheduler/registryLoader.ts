/**
 * Registry loading from declarative YAML (ARCHITECTURE section 11). Workers are
 * config, not code; this reads a `workers:` list and optionally hot-reloads it
 * on file change so the worker mix can change without a restart.
 */

import { readFileSync, watch } from "node:fs";
import { parse } from "yaml";
import { Registry, type WorkerRecord } from "./registry.js";

export function loadWorkers(path: string): WorkerRecord[] {
  const doc = parse(readFileSync(path, "utf8")) as unknown;
  const workers = (doc as { workers?: unknown } | null)?.workers;
  if (!Array.isArray(workers)) {
    throw new Error(`registry file ${path} has no top-level 'workers' array`);
  }
  for (const w of workers) {
    if (!w || typeof w !== "object" || typeof (w as WorkerRecord).workerId !== "string") {
      throw new Error(`registry file ${path}: every worker needs a string workerId`);
    }
    if (typeof (w as WorkerRecord).backend !== "string" || typeof (w as WorkerRecord).model !== "string") {
      throw new Error(`registry file ${path}: worker '${(w as WorkerRecord).workerId}' needs backend + model`);
    }
  }
  return workers as WorkerRecord[];
}

export function loadRegistry(path: string): Registry {
  return new Registry(loadWorkers(path));
}

/**
 * Watch a registry file and hot-reload it into an existing Registry on change.
 * Returns a stop function. Reload errors go to onError (the old set is kept).
 */
export function watchRegistry(path: string, registry: Registry, onError?: (err: Error) => void): () => void {
  const watcher = watch(path, () => {
    try {
      registry.replaceAll(loadWorkers(path));
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return () => watcher.close();
}
