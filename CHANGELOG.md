# Changelog

Loom was built over a focused three-day sprint (2026-07-10 to 2026-07-12): the whole M0–M5 spine on day one, then delivery/recovery and hardening driven by real runs. Each milestone was committed and — where it touches real providers — live-verified against actual AI backends (Codex, Claude, Antigravity). This log is derived from the build history.

## 0.6.0 — 2026-07-12
- **Crash diagnosis + bounded retries.** When a worker crashes, the platform records *why*, surfaces it, and refuses to relaunch blindly; retries and revisions are bounded, then escalate.
- **Registry routing tuned as data.** Implementation routes to Codex (terra/luna) with Claude Sonnet 4.6 as the fallback — expressed as capability/cost tuning in the registry, not as operator instructions.

## 0.5.0 — 2026-07-11
- **Fixed six review blockers** and reconciled the `orchestrate` skill's claims to what the platform actually does.
- **Shakedown fixes from the first real multi-task run:** a worker-autonomy directive in every context package (assume, document, proceed — never block on a question no one will answer); network inside the sandbox for installs and local-service tests; an empty-run guard (completed-with-no-changes is a failed run, retried, no review wasted); and stderr attached to errored runs so startup crashes are diagnosable.

## 0.4.0 — 2026-07-11
- **Delivery + recovery**, root-caused from a real overnight run that lost work: the mechanical bot commit was dying on GPG signing under a no-tty sandbox, and the platform's own failing commit was releasing (reaping) the worktree. Fixes: disable signing on the bot commit; move push + PR to an unsandboxed delivery step so a delivery failure is a recorded escalation, not silent loss; add `resumeFromBranch` recovery so a re-run continues prior work instead of rebuilding.
- **Exposed recovery + delivery controls** on the client surfaces.
- **Fixed `loom serve`** failing to connect: shipped a starter `registry.yaml` and clearer errors.

## 0.3.0 — 2026-07-10
- **Operator surface (M3).** A long-lived MCP server exposing the Dispatch API, a continuous background daemon runtime, and a monitoring aggregate. The `orchestrate` skill was reconciled to the real (snake_case) MCP tool names.
- **Capability scheduling (M4).** Weighted capability score (policy-as-data weights), cost-tier routing (trivial → cheap, hard → strong, reviews → strong reviewer), historical-success feedback, and an exploration bonus.
- **Extensibility + security (M5 pt 1).** A third backend added purely as *adapter + registry rows* to prove zero-change extensibility, plus secret scrubbing of context packages before they leave the machine.
- **More backends.** A Gemini adapter (structural only — live verification blocked by CLI auth), then **Antigravity (`agy`)** as a fourth backend — the first plain-text (non-JSONL) backend, live-verified end to end, generalizing the contract beyond JSON streams.

## Initial build — 2026-07-10
- **Design + adversarial-review hardening.** The architecture, implementation plan, and operator skill, hardened against an adversarial review (Gemini 2.5 Pro + Claude).
- **The spine (M0).** The backend-adapter contract (the sole provider boundary), event-sourced SQLite persistence (write-ahead + transactional outbox), task/run state machines, scheduler/dispatcher, restart reconciliation, and a scriptable fake backend + conformance suite. Gated by a kill-mid-run recovery test and a dependency-direction guard.
- **Two real backends (M1).** Codex (`codex exec`, JSONL stream) and Claude (`claude -p`, stream-json) shipped as co-first-class peers behind one contract, with git-worktree isolation, wall-clock timeouts, a context builder, and a YAML registry. Live-verifying them surfaced real bugs the fakes couldn't: Codex rejects `-a` and uses `thread_id` not `session_id`; the process runner hung because stdin stayed open; isolation was handed a repo name instead of a path.
- **Spec-readiness gate.** An up-front readiness audit plus an admission gate that escalates underspecified tasks rather than dispatching them.
- **Review pipeline (M2).** Independent reviewer selection (never the implementer), real review (native or dispatched), a bounded revision loop, alternate-worker retry, and escalation as a first-class state — plus a `loom run` CLI and an end-to-end live verification.
