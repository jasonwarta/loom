# Changelog

Loom was built as a sequence of milestones, each committed and — where it touches real providers — live-verified against actual AI backends (Codex CLI, Claude, and Antigravity). This log captures the evolution.

## Review-findings hardening
- The platform executes each task's `verificationCommand` before review, so acceptance is objective rather than a judgment call.
- Reviews run read-only in the implementer's worktree; revisions continue the prior branch instead of rebuilding.
- Escalation reasons are exposed through the Dispatch API (`get_result.events`, `status.openEscalations`).
- The queue honors priority with a slot-pool drain; a default wall-clock timeout was added; repo binding is enforced on `dispatch_worker`.

## Delivery + recovery
- One shippable PR per completed task: on review-accept the platform commits, pushes, and opens a PR — it never merges autonomously.
- `resumeFromBranch` recovery: a re-run continues prior work in the existing worktree instead of starting over.
- Root-caused from a real failed run: a mechanical bot commit was dying on GPG signing under a no-tty sandbox, and the lost work traced to the platform's own commit failing and releasing the worktree. Fixes: disable signing on the bot commit; move push/PR to an unsandboxed delivery step so a delivery failure is a recorded escalation, not silent loss.

## M5 — extensibility + security
- Third and fourth backends (Gemini stream-json; Antigravity plain-text) added as *adapter + one composition-root line*, with zero changes above the boundary — proven by diff and enforced by a dependency-direction test.
- Secret scrubbing of context packages before they leave the machine for a remote model.

## M4 — capability scheduling
- Weighted capability score (policy-as-data weights); cost-tier routing (trivial -> cheap worker, hard -> strong worker, reviews -> strong reviewer); historical-success feedback; and an exploration bonus so a new worker isn't starved by an incumbent.
- Hard cost/concurrency ceilings enforced at dispatch and mid-run.

## M3 — operator surface
- A long-lived MCP server exposing the Dispatch API (`dispatch_worker`, `query_queue`, `get_result`, `status`, and more), a continuous background daemon, and a monitoring aggregate.

## M2 — review + recovery
- Independent reviewer selection (never the implementer), real review (native or dispatched), a bounded revision loop, alternate-worker retry, and escalation as a first-class state.

## Spec-readiness gate
- An up-front readiness audit plus an admission gate that escalates underspecified tasks rather than dispatching them — autonomous execution has no human per run, so a weak spec is the top failure mode.

## M1 — real backends
- Two co-first-class CLI backends behind one contract: Codex (`codex exec`, JSONL stream) and Claude (`claude -p`, stream-json). Git-worktree isolation, wall-clock timeouts, a context builder, and a YAML worker registry.
- Every live run surfaced a real bug the fakes couldn't: Codex rejects `-a` and uses `thread_id` not `session_id`; the process runner hung because stdin stayed open; worktree isolation was handed a repo name instead of a path. "Done" means executed and verified, not "typechecks".

## M0 — the spine
- The backend-adapter contract (the sole provider boundary), event-sourced SQLite persistence (write-ahead + transactional outbox), task/run state machines, scheduler/dispatcher, restart reconciliation, and a scriptable fake backend + conformance suite.
- Gated by a kill-mid-run recovery test and a dependency-direction guard (nothing above the boundary imports a concrete backend or the SQLite driver).
