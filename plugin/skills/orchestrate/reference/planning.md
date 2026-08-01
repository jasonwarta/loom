# Planning — decomposing an epic into tasks

Read this when you enter the **Plan** step. You only reach it once the **readiness audit (step 1, `reference/readiness-audit.md`) has passed** — never decompose an epic you'd hand back. Your output is a set of tasks the platform can dispatch: each with a clear boundary, executable acceptance criteria, dependencies, and minimal overlap with its siblings. Decomposition is your highest-leverage act — the platform can sequence conflicting tasks, but it cannot un-conflict a bad decomposition.

## What makes a good task

A task is dispatch-ready when a worker who has never seen the epic could implement it from the task alone. That means:

- **A single, bounded outcome.** One coherent change. "Add the `deactivation_reason` lookup table and wire it into the activation endpoint" is a task. "Do the activation work" is an epic.
- **Executable acceptance criteria — the default.** The exact conditions under which the result is accepted, expressed wherever possible as a check a machine can run: a **failing test the worker must make pass**, a build/lint/typecheck that must succeed, a schema the output must satisfy. Ship the check *with* the task as its `verificationCommand` — **the platform executes it in the run's committed worktree before review**: a failure is an objective revise (command output becomes the findings; no reviewer run is spent), a pass is reported to the reviewer so review focuses on semantics. Fall back to prose criteria only where a check genuinely can't express the outcome, and make that prose concrete enough that a reviewer needs no clarification. If you cannot write the acceptance criteria at all, the task is not defined yet; do not dispatch it — the platform's admission gate will escalate it anyway.
- **A stated blast radius.** Which files/modules/symbols the task is expected to touch. Use code-graph impact analysis at planning time to find the real blast radius, not the assumed one. This is how you minimize collision.
- **Its required capabilities, as needs not names.** e.g. "high reasoning + repo familiarity" or "straightforward implementation, cost-sensitive." You state needs; the scheduler picks the worker (see `delegation-and-selection.md`).
- **Its dependencies.** Which other tasks must complete first (`blockedBy`). The platform will not dispatch a task before its prerequisites are `Completed`.

## Sizing

Size tasks so a single run can plausibly complete one. Too large → the worker runs out of context or produces a sprawling diff that is hard to review and prone to conflict. Too small → coordination overhead and integration churn dominate. When unsure, prefer the smaller task with a clear dependency edge over the larger monolith. A task whose acceptance criteria have "and" in three places is probably two tasks.

## Minimizing collision (conflict avoidance is a planning problem)

Two tasks that write the same files will conflict at integration time, and the platform can only resolve that by serializing and re-basing (a revision loop — real cost). Prevent it here:

- **Partition by file/module ownership** where you can. Give each concurrently-dispatched task a disjoint blast radius.
- **Sequence, don't parallelize, genuine dependencies.** If task B builds on task A's new module, make B `blockedBy` A rather than running them together and hoping.
- **Serialize the shared-surface tasks.** When several tasks must touch one hot file (a central router, a schema index), chain them; do not fan them out.
- **Use impact analysis, not intuition.** The code graph knows what depends on what. A change that "looks local" may have wide dependents; check before you decompose around it.

## Dependency graph

Produce an explicit task dependency graph before dispatching. The platform dispatches only dispatch-eligible tasks (all `blockedBy` complete), so the graph *is* your execution order. Keep it as shallow as correctness allows — every unnecessary dependency edge serializes work that could have run in parallel.

## Priority

Set priority from the CTO's intent, not from task convenience. The platform dispatches eligible tasks strictly by `(priority desc, age)` — higher priority first, older first among equals. There is no aging promotion: a low-priority task waits while higher-priority work is dispatchable, so if something must not starve, say so with its priority. Do not micro-manage ordering the scheduler already handles.

## Before you leave the Plan step

Self-check:
- Every task has acceptance criteria a reviewer could apply without asking you a question.
- Concurrently-dispatchable tasks have disjoint blast radius (or are deliberately serialized).
- The dependency graph is acyclic and no shallower edge was missed.
- Nothing in the plan requires an architectural decision that is not already in an approved ADR. (If it does — escalate; do not decide it yourself.)
