/**
 * DaemonRuntime -- the long-lived process wrapper around the ControlPlane.
 *
 * The control plane processes on demand (drain()). A running daemon instead
 * processes CONTINUOUSLY: submit() returns immediately and a coalesced pump
 * drains the queue in the background, so an operator can DispatchWorker and then
 * poll QueryQueue/GetResult rather than blocking on a drain. On start it
 * recovers persisted in-flight state (ARCHITECTURE section 15, 20).
 */

import type { ControlPlane, ReconcileReport, SubmitInput } from "./controlPlane.js";

export interface DaemonRuntimeOptions {
  readonly concurrency?: number;
  /** Optional idle-poll interval (ms) for idle(); tests can lower it. */
  readonly idlePollMs?: number;
  /**
   * How often to probe backend health and refresh registry availability (ms).
   * Default 30s; set to 0 to disable (e.g. tests that don't want the timer).
   * A boot probe also runs once during start(), so availability is live from t=0.
   */
  readonly healthPollMs?: number;
}

export class DaemonRuntime {
  private draining = false;
  private pending = false;
  private stopped = false;
  private readonly concurrency: number | undefined;
  private readonly idlePollMs: number;
  private readonly healthPollMs: number;
  private healthTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly cp: ControlPlane,
    opts: DaemonRuntimeOptions = {},
  ) {
    this.concurrency = opts.concurrency;
    this.idlePollMs = opts.idlePollMs ?? 5;
    this.healthPollMs = opts.healthPollMs ?? 30_000;
  }

  get controlPlane(): ControlPlane {
    return this.cp;
  }

  /** Recover persisted state, probe backend health, then start processing. */
  async start(): Promise<ReconcileReport> {
    const report = await this.cp.recover();
    // Boot health probe (ARCHITECTURE section 25) + periodic refresh so registry
    // availability is a LIVE signal. No-op with no backends (observe mode never
    // start()s anyway). unref() so the timer never keeps the process alive.
    await this.cp.refreshHealth();
    if (this.healthPollMs > 0) {
      this.healthTimer = setInterval(() => void this.cp.refreshHealth().catch(() => {}), this.healthPollMs);
      this.healthTimer.unref?.();
    }
    this.kick();
    return report;
  }

  /** Submit a task and signal the pump. Returns immediately with the task id. */
  submit(input: SubmitInput): string {
    const id = this.cp.dispatchWorker(input);
    this.kick();
    return id;
  }

  /** Signal that there may be work; coalesces concurrent kicks into a single drain loop. */
  kick(): void {
    if (this.stopped) return;
    this.pending = true;
    if (!this.draining) void this.pump();
  }

  private async pump(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending && !this.stopped) {
        this.pending = false;
        await this.cp.drain(this.concurrency !== undefined ? { concurrency: this.concurrency } : {});
      }
    } finally {
      this.draining = false;
    }
  }

  /** Resolve once the queue has quiesced (no drain in flight and nothing pending). */
  async idle(): Promise<void> {
    while (this.draining || this.pending) {
      await new Promise((r) => setTimeout(r, this.idlePollMs));
    }
  }

  /** Stop accepting new work and wait for the current drain to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    await this.idle();
  }
}
