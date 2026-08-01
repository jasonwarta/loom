# Review methodology & completion

Read this when a task reaches **Review** or when you are deciding whether the epic is done.

## Review is mandatory and independent

No result is accepted on its author's word. Review is **automatic** — the platform does it for every completed run; there is no review tool for you to call. What the platform guarantees:

- **Verification runs first.** If the task shipped a `verificationCommand`, the platform executes it in the run's committed worktree *before* review. A failure is an objective revise — the command output becomes the findings and no reviewer run is spent. A pass is reported to the reviewer, so the review focuses on semantics rather than "do the tests pass."
- **An independent reviewer, automatically.** The platform selects a reviewer that is a **different worker** than the implementer (a hard constraint) and routes by review capability (the "reviews go to a strong reviewer" policy). You do not review the work yourself, and the implementer never grades its own homework. If no independent reviewer is available, the task escalates rather than self-reviewing.
- **The reviewer sees the artifact, not the story.** It runs read-only in a checkout of the implementation branch, with the acceptance criteria — not the implementer's reasoning. Review the code, not the narrative.
- **Verdicts are structured:** `accept`, `revise`, or `reject`, with findings. The platform applies the verdict automatically; you **observe** it via `get_result` and act only where judgment is required (escalations).

## Acting on verdicts

- **accept** → the task is `Completed`; its branch is ready to integrate. Proceed to integration.
- **revise** → the platform re-queues the task with the review findings prepended to the next run's context, and the revision run **continues the prior attempt's branch** (the committed work the findings refer to — not a restart from base). This loops, **bounded** by a revision limit. You do not hand-carry the feedback; the platform does. You *do* watch the revision count.
- **reject** → the reviewer judged the result unsalvageable; the platform **escalates** it to you (it does not silently retry a rejected result). Treat it as a signal and diagnose: was the approach wrong, or was the **task/spec wrong**? See `failure-and-escalation.md`. A reject is information, not just a setback.

## Watch the revision rate

Revision rate is your best proxy for decomposition and context quality. A task that needs three revision loops is usually telling you one of:
- The acceptance criteria were vague (the worker and reviewer disagreed on "done") — tighten them.
- The context package was wrong (missing a key dependency, or bloated with noise) — fix the context directives.
- The task was too large — it should have been decomposed.

If revisions cluster on a particular task type or area, that is a planning defect to fix, not a worker to blame. When a task exhausts its revision bound, it escalates — do not manually re-loop past the bound to force it through.

## Quality bar for acceptance

The reviewer accepts only when the result **meets its acceptance criteria** — all of them, not the interesting ones. "The feature basically works" is not acceptance if a criterion is unmet. Your leverage over this bar is upstream: write **strong, executable acceptance criteria** (see `planning.md`) so the reviewer's judgment is objective, not a guess. If a criterion turns out to be wrong, that surfaces as a reject/escalation — fix the criterion, never quietly lower the bar.

## Integration

An accepted branch integrates through your merge queue (you never merge to your default branch/production yourself). Sequence integrations to respect dependencies. If a branch conflicts with one that just merged, the platform handles it as a re-base revision run — a normal loop, not an emergency. Do not resolve conflicts by hand-editing outside the task lifecycle; keep everything auditable inside it.

## Task completion vs. epic completion

- A **task** is complete when it is accepted after independent review and its branch is integrated (or queued to integrate).
- The **epic** is complete only when *every* task is complete, no escalation is unresolved, and you have filed the final report. Interesting-tasks-done is not epic-done. Re-read the original epic scope before declaring completion and confirm every part was addressed, not just the salient part.
