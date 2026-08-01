# CLAUDE.md — Loom

Guidance for agents and contributors working in this repository.

## What this is

Loom is a backend-independent orchestration platform for AI-assisted software
engineering: it takes already-specified tasks and runs them to reviewed, integrable
work by dispatching to a pool of interchangeable AI workers. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the design and
[`CHANGELOG.md`](./CHANGELOG.md) for how it evolved.

This repository is a published snapshot of a personal project; it is updated in
batches rather than developed PR-first.

## Build, test, typecheck

```
npm install
npm test          # vitest: conformance, lifecycle, crash recovery, dependency-direction guard, per-backend suites
npm run typecheck
npm run build
```

"Done" means executed and verified, not "it typechecks." Every live run in this
project's history surfaced a bug the fakes could not — prefer real execution over
green unit tests alone.

## Core invariants (don't break these)

- **One adapter contract is the sole provider boundary.** Everything above it —
  scheduler, queue, dispatch API, operator skill — speaks normalized types only. A new
  backend is *an adapter + registry rows*; nothing above the boundary changes. A
  dependency-direction test enforces that nothing above the boundary imports a concrete
  backend or the SQLite driver.
- **Task is not Run.** Retries, alternate-worker attempts, and revisions are new runs,
  not mutations. Keep run history append-only and auditable.
- **The registry is data, not code.** `registry.yaml` maps worker ids to
  (backend, model, capability profile). Model ids in it are examples — set them to what
  your backends actually expect.
- **No autonomous merge.** The platform produces reviewed branches/PRs; it never merges
  on its own.
- **Secrets never leave the machine unredacted.** Context packages are scrubbed of
  common secret shapes before dispatch to a remote model; keep that guarantee intact.

## Layout

See the "Repository layout" section of [`README.md`](./README.md).
