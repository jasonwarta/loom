# Loom

A backend-independent orchestration platform for AI-assisted software engineering. Loom begins **after discovery** (epic, specs, ADRs, and acceptance criteria already exist) and does one thing: **disciplined execution** — turning well-specified tasks into reviewed, integrable work by dispatching them to a pool of interchangeable AI workers.

Its execution backends — the **Codex CLI**, **Claude**, and a plain-text CLI backend — ship as co-first-class peers, but no backend is an assumption: the whole design optimizes for replacement. A new provider is an *adapter + a registry entry*; the scheduler, dispatch API, and operator playbook never change.

## The one idea

The operator should never think *"how do I invoke Codex?"* — only *"dispatch this task to the best-fit worker."* Everything provider-specific lives behind one adapter contract; everything above it stays stable while execution technology evolves.

## What it does

- **One narrow backend-adapter contract** is the sole provider boundary. Everything above it — scheduler, queue, dispatch API, operator skill — speaks normalized types only.
- **Capability-based scheduling.** Workers are chosen by declared capability + live state + a tunable weight vector, never by name. Cost is a penalty scaled by task difficulty: trivial tasks route to cheap workers; hard tasks and reviews to strong ones.
- **Task ≠ Run.** A task has many runs; retries, alternate-worker attempts, and revisions are new runs, not mutations — so history stays auditable and recovery stays clean.
- **Event-sourced persistence on SQLite** (write-ahead + transactional outbox). The platform survives restarts and reconciles in-flight runs against the backends.
- **Independent review.** Every completed run is reviewed by a *different* worker by default, with a bounded revision loop, alternate-worker retry, and escalation as a first-class state.
- **Isolation and delivery.** Each run works in its own git worktree; on accept the platform commits, pushes, and opens a PR — it never merges autonomously.
- **Secret scrubbing.** Context packages are redacted of common secret shapes before they leave the machine for a remote model.

## Drive it (two ways)

**One-shot CLI** — run a single task:
```
npm run build
node dist/cli/index.js run --registry ./registry.yaml --repo /path/to/repo \
  --task "..." --criteria "criterion one; criterion two"
```

**As an MCP server** — let an operator drive it through the Dispatch API tools:
```
npm run build
node dist/cli/index.js serve --registry ./registry.yaml --repo /path/to/repo
```
The operator calls `dispatch_worker`, `query_queue`, `get_result`, `status`, and more. `registry.yaml` needs at least two workers (one implementation-preferred, one review-preferred) so review has an independent reviewer.

## Repository layout

```
docs/
  ARCHITECTURE.md            the platform design (contract, scheduler, lifecycle, persistence, review, ADRs, risks)
  IMPLEMENTATION-PLAN.md     the milestone build order
src/
  contract/                  the Backend contract + normalized types (the sole provider boundary)
  backends/                  adapters (codex, claude, antigravity, plus a scriptable fake for tests)
  persistence/               event-sourced SQLite store (write-ahead, transactional outbox)
  domain/                    Task/Run model, state machines, readiness + review seams
  scheduler/                 worker registry + capability scheduler + scoring
  dispatcher/                run lifecycle (intent -> dispatch -> poll -> result)
  daemon/                    control plane (Dispatch API) + composition root
  delivery/                  push + PR on accept
  isolation/                 git-worktree isolation
  mcp/                       MCP server exposing the Dispatch API
  cli/                       break-glass CLI
test/                        conformance, lifecycle, reconciliation/chaos, per-backend suites
plugin/                      the Claude Code plugin: the 'orchestrate' operating playbook
registry.yaml                the worker registry (data, not code)
```

## Development

```
npm install
npm test          # contract conformance, lifecycle, crash recovery, dependency-direction guard, per-backend suites
npm run typecheck
npm run build
```

## License

MIT — see [LICENSE](./LICENSE).
