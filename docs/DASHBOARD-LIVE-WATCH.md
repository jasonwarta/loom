# Design note — Dashboard for live epic watching

**Status:** Implemented (this branch)
**Extends:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) §26 (additional client surfaces) and the
read-only kanban dashboard shipped in the prior change (`src/ui/*`).
**Scope:** a *read-only* enhancement of an existing client surface. It adds no new
system and changes no invariant, so it is a design note, not a full spec.

## Goal

Make the dashboard good enough to **watch a real, in-flight epic being implemented
live** — not merely review a finished run after the fact. That means: see what each
running task is doing, how long it has been doing it, which worker owns it, and — when
something escalates or revises — *why*, without dropping to the MCP tools or the DB.

## Hard constraints preserved

- Dashboard is a **single self-contained HTML string** (`src/ui/dashboard.ts`) — inline
  CSS/JS, zero dependencies.
- The HTTP transport stays **GET-only / observe-only**: no mutating route exists; every
  non-GET returns 405. All mutation stays on the MCP path.
- The `ui` layer **imports no backend**; the dependency-direction guard
  (`test/architecture.test.ts`) keeps passing.
- Tests stay green.

## What the store already carries (verified, not assumed)

Read against the code on this branch:

- **Timestamps** (`persistence/store.ts`): `run.created_at` (dispatch intent),
  `run.started_at` (set when the native handle attaches → run goes `running`),
  `run.ended_at` (terminal); `run_result.stored_at`; `task.created_at` / `updated_at`;
  every `task_event.at`. Sufficient to derive elapsed + duration. The dashboard binds
  loopback, so the browser clock equals the server clock and elapsed is computed
  client-side against `run.startedAt`.
- **Result detail** (`contract/types.ts` `RunResult`): `error.{code,message,retryable}`
  and `usage.{tokens,costUsd,durationMs}` are persisted per run — the diagnosable stderr
  tail and per-run cost/duration are already there, they were just not rendered.
- **Review findings gap:** verdict findings are persisted in the `review` table but were
  **not exposed** by `getResult` (events carry only `{runId, verdict}`). This note adds a
  read-only `reviewsByTask` accessor and surfaces `findings` in the result view.

## Decisions

1. **Enrich the read verbs with *derived* fields; do not add a new pipeline.**
   `queryQueue` gains, per task: `createdAt`/`updatedAt`, per-task `costUsd`, and — for
   in-flight / needs-attention tasks — a `currentRun` summary (`workerId`, `backendId`,
   `state`, `startedAt`) plus `attempts` / `revisions`. `getResult` gains `reviews[]`.
   All additive, all store-derived, still GET-only. The board stays a single fetch (no
   N+1 `get_result` per card).

2. **Observe-only launch (`loom view`).** Attaching the dashboard to an existing store
   must never re-dispatch work. `serve` starts the runtime (`recover()` + `drain()`)
   *before* mounting the UI, so pointing it at a populated store re-runs eligible tasks —
   a money/mutation footgun. `loom view` builds a control plane over the store with an
   **empty backend map** and **never starts the runtime**: the five read verbs read
   straight from the store, so no daemon is required to view. It opens a **temp copy** of
   the `.loom.sqlite` (plus `-wal`/`-shm`), so viewing a real run cannot mutate it.
   Live watching of a *currently running* epic uses `serve --ui-port` (the daemon running
   the epic also serves the board — one process, one DB).

3. **Live per-worker output tail is deferred (not faked).** Verified: the CLI backend
   holds `progress`/stdout in memory only and persists `stderr` just at exit; only the
   final `RunResult` reaches the store. A live tail would require persisting incremental
   output **below the adapter boundary** (a backend + store change) and a new read
   endpoint — out of scope for a read-only client change. The board instead surfaces the
   store-backed live signals that *do* exist: worker, elapsed, attempt/revision count,
   and (on terminal) the error message. Tracking follow-up: "persist per-run output for
   live tail" (see PR body).

## Worker identity vs. availability (two distinct signals)

The worker strip carries two intentionally-separate channels, because conflating them was
confusing:

- **Identity** — a stable per-worker color (a *square* swatch), shown on the strip and on
  each in-flight card's worker chip and the drawer's run rows. This is what lets you see
  "this model → these tasks" at a glance. It carries no status meaning.
- **Availability** — the *round* dot (green/amber/grey/red). This is now a **live signal
  when a daemon is running**: `DaemonRuntime` probes every backend's `healthcheck()` on boot
  and on an interval (default 30s) and pushes the result into registry availability via
  `ControlPlane.refreshHealth()` → `Registry.setAvailability()` (ARCHITECTURE §19). A backend
  that reports non-`available` or whose probe throws flips all its workers, the scheduler's
  hard constraint routes around them, and the dashboard shows it live (the dot's tooltip reads
  "live, checked Ns ago"). In **observe mode** (`loom view`) there is no daemon and no backend
  map, so `refreshHealth` is a no-op and the dot stays **static registry config** — the tooltip
  says so, and the absence of `lastHealthAt` is how the dashboard tells the two apart.

Not yet built: an **in-run** rate-limit signal (flip a worker to `rate_limited` mid-run on a
provider 429). The contract has no distinct rate-limit error code today, so detecting it would
mean string-matching error text — deferred rather than hacked in. The periodic health probe is
the live mechanism for now.

## Out of scope (unchanged)

Any operator action from the dashboard (cancel / retry / resume / re-prioritize).
Mutation stays on MCP. Auth/sharing beyond loopback (noted, not built).
