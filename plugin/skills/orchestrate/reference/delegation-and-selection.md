# Delegation & worker selection

Read this when you enter the **Dispatch** step. It covers how to submit a task and — the part that matters most — how to think about worker selection.

## Selection philosophy: needs, not names

The single discipline: **you describe what the task needs; the platform picks who runs it.** You never route by worker identity.

Concretely, a dispatch carries:
- **Task requirements** — the capability profile the work demands: reasoning depth, coding strength, review independence, investigation ability, repo familiarity, cost sensitivity, latency sensitivity.
- **A worker preference (optional)** — a hint, when you have a real reason (e.g. "the worker that just built the adjacent module has warm repo context, prefer it"). The scheduler treats preference as an additive prior. It **may** override the preference with recorded justification, and it **will** override it to honor hard limits (worker offline/rate-limited, over cost ceiling, task context won't fit, reviewer must differ from implementer). An override is the system working, not failing.

Why this matters: the worker pool is data and it changes. New models arrive; workers get rate-limited; costs shift. If your delegation logic named workers, it would break every time the pool changed. Because it names *needs*, it never breaks. When a strictly better coding model joins the registry tomorrow, your behavior is identical and the scheduler simply starts choosing it for the tasks it fits.

**Anti-patterns to catch in yourself:**
- "Send all the hard ones to a high-reasoning worker." → That is a registry policy (which worker has high reasoning), expressed as tuning data by whoever owns the platform config — not a per-dispatch decision. State "needs high reasoning" and stop.
- Calling `query_registry` to pick a worker by hand. → `query_registry` is for confirming the pool is healthy and diverse enough, not for hand-routing. If you are choosing a `worker_id` to put in a dispatch, you have slipped into identity-based selection.
- Refusing the scheduler's choice and re-dispatching to force a specific worker. → If the scheduler chose differently, either your stated needs were wrong (fix them) or a hard limit applies (respect it).

## Composing the dispatch

`dispatch_worker` takes: task spec + acceptance criteria, task type, priority, effort, **context directives**, repo/base branch, isolation policy, constraints (time/cost budget), expected deliverables (and an output schema when you need a structured deliverable), and the optional worker preference.

### Context directives (let the platform build the package)

You do not paste files. You tell the Context Builder what the task needs and it assembles the **minimal sufficient** package (and guarantees it fits the chosen worker's context window):
- The specs/ADRs/acceptance criteria the task references.
- The symbols/modules in scope — prefer "this function, its callers, its type deps" (code-graph retrieval) over "this whole file."
- Explicit file globs when you know the blast radius.
- For a revision run, the prior review findings are attached automatically — you do not re-explain them.

Sending more context is not safer. Irrelevant context degrades output. Ask for what the task needs and no more.

### Effort and constraints

Set `effort` to the task's genuine difficulty, not the maximum. High effort on trivial work is waste; low effort on hard work produces revisions. Set time constraints from the task's value — wall-clock budgets are hard ceilings the platform enforces (a hung run is cancelled, not left holding a slot; there is also a platform default). Cost ceilings are enforced only as far as a backend reports cost — some don't, so treat reported spend as a floor and cost discipline as partly yours.

## Isolation and parallelism

Every implementation run executes in its own isolated workspace (the platform creates it) so concurrent runs cannot clobber each other. You enable parallelism by **decomposing for disjoint blast radius** (see `planning.md`) and dispatching independent tasks together. You do not manage worktrees or branches — that is the platform's job. Your job is to not dispatch two tasks that will fight over the same files at the same time.

## After dispatching

- Monitor via `query_queue` and `inspect_worker` — never assume progress from memory.
- Do not poll obsessively or micro-manage a running task. Let it run; the platform reports state transitions.
- When a task reaches `Review`, move to the review step (`review-and-completion.md`). When it `Waiting`s (needs input), supply it via `resume_task` if it is within your authority, or escalate if it is not.
