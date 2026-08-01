/**
 * Composition root. This is the ONE place that knows about concrete backends
 * and wires them into the control plane. Everything the control plane does
 * above this point is expressed through the Backend contract, so swapping or
 * adding a backend is a change HERE plus a registry entry -- nowhere else
 * (the prime directive; enforced by test/architecture.test.ts).
 */

import type { Backend } from "../contract/backend.js";
import { LoomStore } from "../persistence/store.js";
import { Registry, type WorkerRecord } from "../scheduler/registry.js";
import { loadRegistry } from "../scheduler/registryLoader.js";
import { ControlPlane } from "./controlPlane.js";
import { FakeBackend } from "../backends/fake/fakeBackend.js";
import { CodexBackend } from "../backends/codex/codexBackend.js";
import { ClaudeBackend } from "../backends/claude/claudeBackend.js";
import { GeminiBackend } from "../backends/gemini/geminiBackend.js";
import { AntigravityBackend } from "../backends/antigravity/antigravityBackend.js";
import { RealProcessRunner } from "../backends/process/runner.js";
import { WorktreeManager } from "../isolation/worktree.js";
import { GitHubDelivery } from "../delivery/delivery.js";
import { FileContextBuilder } from "../context/contextBuilder.js";

export interface LoomConfig {
  readonly dbPath: string;
  readonly workers: readonly WorkerRecord[];
  readonly backends: ReadonlyMap<string, Backend>;
}

export interface LoomInstance {
  readonly store: LoomStore;
  readonly controlPlane: ControlPlane;
  close(): void;
}

/** Wire a control plane from explicit config. Real deployments build the backends map here. */
export function createLoom(config: LoomConfig): LoomInstance {
  const store = new LoomStore(config.dbPath);
  const registry = new Registry(config.workers);
  const controlPlane = new ControlPlane({ store, registry, backends: config.backends });
  return { store, controlPlane, close: () => store.close() };
}

/**
 * A self-contained demo stack backed by the FakeBackend -- no external provider,
 * no cost. This is the M0 "usable functionality": the whole pipeline runs.
 */
export function createDemoLoom(dbPath = ":memory:"): LoomInstance {
  const backends = new Map<string, Backend>([["fake", new FakeBackend()]]);
  const workers: WorkerRecord[] = [
    {
      workerId: "fake-worker",
      displayName: "Fake Worker",
      backend: "fake",
      model: "fake-model",
      availability: "available",
      preferredTaskTypes: ["implementation", "review"],
    },
  ];
  return createLoom({ dbPath, workers, backends });
}

export interface LiveLoomConfig {
  readonly dbPath: string;
  /** Path to a YAML registry (workers routed to the "codex"/"claude" backends). */
  readonly registryPath: string;
  /** Repo the tasks operate on; used for worktrees + context file resolution. */
  readonly repoRoot: string;
  readonly worktreeBaseDir?: string;
  readonly dispatch?: { pollDelayMs?: number; wallClockMs?: number };
  /**
   * Delivery of accepted work (push + PR), run platform-side from `repoRoot`.
   * Omit to disable delivery -- accepted work then stays on its local branch.
   */
  readonly delivery?: { enabled?: boolean; remote?: string; draft?: boolean };
}

/**
 * The real composition root: wires the two live CLI backends (Codex, Claude),
 * git-worktree isolation, and the file context builder. THIS is the only place
 * that names concrete backends -- adding a third is a change here + a registry
 * entry, nowhere else (the prime directive).
 */
export function createLiveLoom(config: LiveLoomConfig): LoomInstance {
  const store = new LoomStore(config.dbPath);
  const registry = loadRegistry(config.registryPath);
  const runner = new RealProcessRunner();
  const backends = new Map<string, Backend>([
    ["codex", new CodexBackend(runner)],
    ["claude", new ClaudeBackend(runner)],
    ["gemini", new GeminiBackend(runner)], // third backend: adapter + this line, nothing above the boundary
    ["antigravity", new AntigravityBackend(runner)], // fourth backend (agy: plain-text CLI, Gemini/Claude/GPT roster)
  ]);
  const controlPlane = new ControlPlane({
    store,
    registry,
    backends,
    isolation: new WorktreeManager({
      repoRoot: config.repoRoot,
      ...(config.worktreeBaseDir !== undefined ? { baseDir: config.worktreeBaseDir } : {}),
    }),
    // Delivery is ON by default (the point is that accepted work ships); disable
    // explicitly with delivery.enabled=false to leave work on its local branch.
    ...(config.delivery?.enabled !== false
      ? {
          delivery: new GitHubDelivery({
            repoRoot: config.repoRoot,
            ...(config.delivery?.remote !== undefined ? { remote: config.delivery.remote } : {}),
            ...(config.delivery?.draft !== undefined ? { draft: config.delivery.draft } : {}),
          }),
        }
      : {}),
    contextBuilder: new FileContextBuilder({ repoRoot: config.repoRoot }),
    // Default wall-clock: without one, a hung CLI holds a concurrency slot for
    // ~27h (the poll-count safety net). Per-task wallClockMs still overrides.
    dispatch: {
      pollDelayMs: config.dispatch?.pollDelayMs ?? 1000,
      wallClockMs: config.dispatch?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
    },
    // Revision budget: substantial multi-chunk tasks need more than the default
    // 2 review->revise rounds to converge (the reviewer surfaces deeper issues
    // as surface ones are fixed). Override with LOOM_MAX_REVISIONS.
    retry: { maxRevisions: Number(process.env.LOOM_MAX_REVISIONS) || 5 },
  });
  return { store, controlPlane, close: () => store.close() };
}

/** 2 hours: generous for a real implementation run, small enough that a hung run can't stall an overnight epic. */
const DEFAULT_WALL_CLOCK_MS = 2 * 60 * 60 * 1000;
