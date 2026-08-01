# Readiness audit — the gate before you build anything

Read this at **step 1**, before decomposing or dispatching. Its job is to answer one question honestly: **is this epic ready to be executed by autonomous workers with no human in the loop per run?** If not, you stop and hand it back. This is the highest-leverage thing you do, because every downstream cost — worker-runs, review cycles, integration, your own coordination — is wasted on a spec that wasn't ready.

You are **empowered and expected** to return work to the CTO/the human: *"This isn't ready to execute. Here's what's underspecified. Flesh it out and come back."* That is a success, not a failure.

## Why this gate is strict here specifically

In interactive development a human catches ambiguity as it appears. In autonomous execution there is no such human per run: an ambiguous acceptance criterion becomes a worker confidently building the wrong thing, a review that can't objectively judge it, a revision loop, and a late, expensive discovery. The cost of a weak spec is paid *after* you've spent the tokens, not before. So the bar to **start** is high on purpose.

## The audit checklist

Run every item against the epic and its specs/ADRs. Cite where each is satisfied (a spec section, an acceptance criterion) — if you can't cite it, it's not satisfied.

1. **Outcome is defined.** There is a clear statement of what "done" means for the epic, not just a direction of travel.
2. **Acceptance criteria exist and are checkable.** Every intended outcome has criteria a reviewer could apply without asking a question — ideally *executable* (a test, a build/lint, a schema). Prose like "works well" or "is fast" is not a criterion.
3. **Scope boundaries are drawn.** What is in and what is explicitly out. Open-ended scope cannot be decomposed into bounded tasks.
4. **Contracts/interfaces the work touches are specified** (APIs, schemas, data shapes) — or explicitly delegated to a task whose job is to define them.
5. **Architectural decisions are made, not implied.** If the work needs a decision someone would cite later, the ADR exists. You do **not** make it yourself (that's an escalation); you require it to exist.
6. **Dependencies and sequencing are knowable** from the spec — you can see what must precede what.
7. **No load-bearing UNKNOWNs.** A spec with open questions marked UNKNOWN on anything that blocks implementation is not ready; the UNKNOWNs are exactly the hand-back list.
8. **No collision with in-flight work.** No open PR, unmerged branch, or running task already implements part of this epic. If prior work exists, you have decided *per item* whether to build on it, supersede it, or sequence around it — see the collision audit below. Rebuilding from scratch on top of in-flight work guarantees merge conflicts and wasted worker-runs.

## Check for in-flight work — the collision audit

This is a distinct check with a hard constraint: **it is yours to run, and only yours.** No worker can be relied on to see GitHub: workers run headless in isolated worktrees with network for installs and tests against local services — not a mandate, instruction, or auth duty to audit PRs. You, the orchestrator, are the only role with `gh` responsibilities. So if you skip this, *nobody* does it, and the platform will happily dispatch workers to rebuild code that's already in flight. (This is not hypothetical: an overnight run once rebuilt an entire epic from scratch while three open PRs already implemented it — every branch it produced would have conflicted.)

Run this **before decomposing**, scoped to the epic's area (its issue numbers, target paths, branch-naming convention):

- `gh pr list --state open --search "<epic keyword / issue #>"` — open PRs already touching this epic.
- `gh pr list --state merged --search "..."` — recently merged work that may already cover a slice you were about to task out.
- `git branch -r --list '*<area>*'` and `git branch --list 'loom/*'` — remote and prior Loom branches holding unmerged work (including work an earlier orchestration run committed but never delivered).
- For each hit, inspect what it changes — `gh pr view <n> --json title,state,isDraft,files` — and check whether it overlaps the tasks you are about to create.

For **every** overlap, decide explicitly — this reconciliation happens before any dispatch:

- **Build on it** — the existing branch/PR is the right base. Dispatch the continuing task with `resumeFromBranch` set to that branch (recovery mode): the worker's workspace is checked out on it and the worker is told to assess and *continue* the work, not restart. This is the correct move for work a prior run produced but never pushed.
- **Supersede it** — the existing work is stale or wrong and you are replacing it. Say so in your plan, and close/mark the old PR so it can't be merged in parallel with your replacement.
- **Sequence around it** — both are needed but touch the same files. Sequence them through the merge queue and set task `deps` so they never run concurrently on the same area.

## The outcome gate (pick one, explicitly)

- **Proceed** — the audit passes *and* in-flight work is reconciled (every overlapping PR/branch has a build-on / supersede / sequence decision). Go to step 2 (Plan). Note anything minor you're proceeding despite.
- **Hand back** — a load-bearing part is underspecified. **Stop. Do not decompose or dispatch.** Return to the CTO/the human with (a) exactly what is missing or ambiguous, item by item, and (b) what "ready" would look like for each. Then wait; do not start on "the clear parts" in the meantime — partial starts on a spec that then changes are rework.
- **Narrow, then proceed** — the epic as a whole is under-baked, but a genuinely well-specified, independently valuable slice exists. You may scope down to that slice and proceed on it *only*, and hand back the rest. Use this when it delivers real value and doesn't bet on the vague parts; do not use it to rationalize starting on shaky ground.

If you're unsure between Proceed and Hand back, hand back. The asymmetry favors it: an unnecessary hand-back costs a message; an unnecessary start costs a fleet of worker-runs and a late discovery.

## How to hand back well

Be specific and actionable — a hand-back is a work order, not a complaint:
- Name each gap concretely ("the `ingestion` endpoint has no acceptance criteria for malformed input"), not generally ("needs more detail").
- Say what would make it ready ("add expected behavior + an example payload + the error contract for the malformed case").
- Where you can, suggest the executable check that should exist ("a test asserting a 422 with error code X").
- If a slice is ready, say so and offer to proceed on that slice while the rest is fleshed out.

## Relationship to the platform's admission gate

The platform runs a **task-readiness gate** at admission: a task submitted without real acceptance criteria is escalated, not dispatched. That is a mechanical backstop for *individual tasks you might under-specify during decomposition*. It is **not** a substitute for this audit — it cannot judge whether the *epic* is coherent, only whether a single task has criteria. This audit is yours; the gate just guarantees a slipped-through weak task can't reach a worker.
