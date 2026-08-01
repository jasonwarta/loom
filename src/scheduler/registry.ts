/**
 * Worker Registry (ARCHITECTURE section 11). Workers are configured DATA, not
 * code. The scheduler consumes capability profiles from here; adding a worker
 * never touches the scheduler.
 *
 * M0 carries the full record shape but the trivial scheduler only reads the
 * fields it needs (backend, availability, access, concurrency, task-type tags).
 */

import type { Effort } from "../contract/index.js";

export type CostTier = "low" | "medium" | "high";
export type LatencyTier = "fast" | "medium" | "slow";
export type Availability = "available" | "degraded" | "offline" | "rate_limited";

export interface CapabilityStrengths {
  readonly coding?: number;
  readonly reasoning?: number;
  readonly review?: number;
  readonly investigation?: number;
}

export interface WorkerRecord {
  readonly workerId: string;
  readonly displayName?: string;
  readonly provider?: string;
  /** The backend adapter id that runs this worker. */
  readonly backend: string;
  /** Concrete model the adapter requests. */
  readonly model: string;
  readonly defaultEffort?: Effort;
  readonly contextWindow?: number;
  readonly costTier?: CostTier;
  readonly latencyTier?: LatencyTier;
  readonly strengths?: CapabilityStrengths;
  readonly toolAccess?: readonly string[];
  readonly repositoryAccess?: readonly string[];
  readonly concurrencyLimit?: number;
  readonly availability?: Availability;
  readonly preferredTaskTypes?: readonly string[];
  /** Cumulative cost ceiling (USD). When spend reaches it, the worker is ineligible. */
  readonly costCeilingUsd?: number;
}

export class Registry {
  private readonly workers = new Map<string, WorkerRecord>();

  constructor(workers: readonly WorkerRecord[] = []) {
    for (const w of workers) this.workers.set(w.workerId, w);
  }

  list(): WorkerRecord[] {
    return [...this.workers.values()];
  }

  get(workerId: string): WorkerRecord | undefined {
    return this.workers.get(workerId);
  }

  upsert(worker: WorkerRecord): void {
    this.workers.set(worker.workerId, worker);
  }

  /** Replace the entire worker set (used by hot-reload). */
  replaceAll(workers: readonly WorkerRecord[]): void {
    this.workers.clear();
    for (const w of workers) this.workers.set(w.workerId, w);
  }
}
