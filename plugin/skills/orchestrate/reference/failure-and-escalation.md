# Failure handling, escalation & reporting

Read this when a task fails, stalls, or you need to decide whether something is above your authority.

## Let the platform recover the mechanical failures

Most failures are the platform's to handle, not yours. It will, per its retry policy: retry crashed/timed-out/network-failed runs (often on an alternate worker), treat partial or invalid-schema output as a failed run, and re-queue within the retry budget. **Do not intervene in mechanical recovery.** Cancelling and re-dispatching by hand just fights the retry policy and loses the audit trail. Watch, don't grab the wheel.

Your judgment enters only where recovery needs a *decision*:

## When to switch approach vs. keep retrying

- **Same worker class, transient failure** (a crash, a timeout, a rate limit) → let the platform retry. Nothing for you to do.
- **Different workers, same wall** → when a task fails the same way across two or more different workers, the problem is not the worker. It is the task: an ambiguous spec, a missing dependency, an impossible acceptance criterion, or a decomposition that hid a hard coupling. Stop retrying and diagnose. Retrying a bad spec on a third worker is waste, not diligence.
- **Repeated `reject` at review** → same conclusion: the definition is wrong, not the labor.

## Escalation — the discipline of knowing your limits

Escalate (raise an `Escalated` task with a clear reason) rather than deciding, when:

- The fix requires an **architectural change not covered by an approved ADR.** You do not make architecture decisions to unblock yourself — that is the CTO's authority. Escalate with the specific decision needed.
- The failure implies the **spec or acceptance criteria are wrong.** You cannot rewrite the spec to make a task pass; that hides a real disagreement. Surface it.
- A task needs **scope change** to the epic.
- A **business-impacting decision or tradeoff** is required (cost vs. speed vs. quality beyond configured limits) — escalate to the CTO.
- The retry/revision budget is **exhausted** and the task is still not accepted.
- Anything touches **merge to production** or a legal/financial/customer commitment (this escalates past the CTO to the human).

Escalate **early**. Three attempts into the same wall is enough to know it is a definition problem. Fast escalation of a bad spec is discipline; slow escalation after ten expensive retries is a failure of judgment. When you escalate, state precisely: what was attempted, how it failed, what decision you need, and what you recommend. An escalation without a recommendation is an abdication.

## After a gap or restart

If you lose context (conversation summarized, session restarted), **do not act from memory.** Reconstruct the world from the platform first: `status` (aggregate counts + **open escalations with their reasons**), `query_queue` (what is pending/running), `query_registry` (what workers are available/healthy), `get_result` on in-flight and recently-completed tasks (its `events` history says what happened and *why* — every transition, verdict, and escalation carries its reason). The platform is the source of truth; your recollection is stale cache. Only once you have reconstructed state do you resume the loop. Your notes to a resumed task survive restarts too — `resume_task`'s addendum is delivered durably by the platform, not from your memory.

## Reporting

Report at **handoffs**, not as a running commentary. Send a report when:
- The **epic completes** — what shipped, what was escalated and how it resolved, what (if anything) remains, and the cost/outcome summary.
- You are **blocked or escalating** — the decision you need, with your recommendation (see above). Send this the moment you escalate; do not sit on a blocker.
- A **meaningful milestone** lands — a significant sub-goal of the epic is done and integrated.

Do **not** report per-task progress, routine retries, or normal review loops — that is noise that trains the reader to ignore you. The trigger for a report is "I have finished a chunk, or I am stuck and need you," never "I did a thing."

Every report is backend-neutral: describe workers by their registry identity and the capabilities they brought, never by how they were invoked. The CTO and the human care what got built and what it cost, not which CLI ran.

## Completion

You are done only when the completion criteria in `SKILL.md` are all met and the final report is delivered. Blocked-but-reported and escalated-unresolved are not done — report them as exactly what they are.
