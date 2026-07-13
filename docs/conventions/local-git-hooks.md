# Local Git Hooks

This document defines the current repository-managed local Git hook behavior.

## Purpose

Local hooks should catch cheap, deterministic issues before code leaves a developer machine.

They should:

- fail early on formatting or boundary violations
- stay aligned with repository scripts and pull-request checks
- keep `pre-commit` light enough for normal daily use

They should not:

- hide logic in ad hoc shell fragments that cannot be run directly
- duplicate complex validation flows with different commands than CI

## Current Hooks

The repository currently uses `husky` with two primary hooks:

- `pre-commit`
- `pre-push`

## `pre-commit`

`pre-commit` should stay focused on staged-file hygiene and fast checks.

Current behavior:

- `pnpm exec lint-staged`
- `pnpm check:electron-runtime-boundaries:staged`
- `pnpm check:ui-boundaries:staged`
- `pnpm check:renderer-boundaries:staged`
- `pnpm check:agent-gui-degradation:staged`

Rules:

- staged-file checks should inspect only staged files when practical
- checks in `pre-commit` should remain fast and deterministic
- package-boundary enforcement that is cheap to evaluate may run here
- TypeScript staged linting should tolerate generated-only changes that are
  ignored by Oxlint while still failing real diagnostics for linted files

## `pre-push`

`pre-push` is the local full-validation gate before code leaves the machine.

Current behavior:

- `pnpm check:full`

`check:full` should remain the stable root command for local full validation.

That root command now uses a repository-owned Node orchestration script so the stable entrypoint stays the same while independent checks can run in parallel in bounded phases:

- the preparation phase generates builtin app assets once
- the preflight phase runs generated-artifact and repository-rule checks in parallel
- the validation phase runs lint, typecheck, and blocking test commands in parallel only after preflight passes

Compact output is the default for both local and automated callers. Each task
writes its complete output under `.tmp/check-full-runs`; successful phases print
only timing summaries. A failed task immediately prints up to 120 filtered
lines, preserving its assertion, location, and stack context while removing
runner boilerplate and repeated consecutive lines. Use
`pnpm check:full -- --verbose` only when live child-process output is needed, or
`--tail-lines <n>` to adjust each failed task's excerpt. The latest
machine-readable task results and log paths are recorded in
`.tmp/check-full-runs/latest.json`.

That full validation currently includes:

- `pnpm check:defaults-generated`
- `pnpm check:agent-gui-provider-catalog-generated`
- `pnpm check:api-generated`
- `pnpm check:event-protocol-generated`
- `pnpm check:i18n`
- `pnpm check:electron-runtime-boundaries`
- `pnpm check:ui-boundaries`
- `pnpm check:renderer-boundaries`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:ts`
- `pnpm test:go`

The lint and typecheck steps in `check:full` should follow the repository's
documented static-analysis scope: TypeScript linting uses Oxlint and workspace
typechecking uses native TypeScript via `tsgo`.

Rules:

- `pre-push` should stay aligned with first-pass pull-request CI checks
- slower cross-workspace validation belongs here rather than in `pre-commit`
- if a check is too expensive for `pre-commit`, keep it in `pre-push` and CI

TypeScript package tests and Go workspace tests use discovery-based runners
instead of root package/module whitelists. Successful runs print compact
summaries with the slowest lanes; complete lane logs and a machine-readable
`latest.json` are stored under `.tmp/test-runs`. Every `go.work` module,
including `packages/agent/daemon`, participates in the blocking Go test gate.
The focused agent daemon command and its stabilization expectations are
documented in [Testing](./testing.md).

For PR branches that often need rebasing or force-pushing, use
`pnpm push:checked` instead of running `pnpm check:full` and `git push`
manually. It fetches the configured remote branch first and stops before
`check:full` if the remote already has commits not present locally. After
`check:full` passes, it pushes `HEAD` with an explicit
`--force-with-lease=<remote-ref>:<fetched-sha>` and disables the Husky
`pre-push` hook for that child push to avoid rerunning the same full gate.
If another contributor pushes during `check:full`, the explicit lease still
rejects the push. The command requires a clean worktree so the validation run
matches the pushed `HEAD`.

## Changed-Aware Validation

Use `pnpm check:changed` as the preferred local iteration check before running
broader validation. It selects checks from the changed file set, runs
independent lanes concurrently, prints compact summaries, and stores full logs
under `.tmp/check-runs`.

Failure output prints an 80-line tail by default. Use
`pnpm check:changed -- --tail-lines <n>` when a larger or smaller tail is more
useful; full logs remain in `.tmp/check-runs`.

When the changed set includes deleted package test files, `check:changed` should
not pass those missing paths to Vitest as explicit targets. Deleting source files
should still keep the surrounding package validation active so typecheck can
catch broken imports.

When the changed set includes deleted TypeScript or JavaScript files,
`check:changed` should also exclude those missing paths from the `lint:changed`
Oxlint invocation while still preserving the broader changed-file set for
boundary checks and package validation.

## UI Boundary Enforcement

The shared UI boundary is enforced in two modes:

- `pnpm check:ui-boundaries:staged` for `pre-commit`
- `pnpm check:ui-boundaries` for `pre-push` and CI

This keeps commit-time feedback narrow to the staged change while still preserving a full-repository guard later in the flow.
The durable details of what the script enforces, including the single allowed non-UI-system workbench stylesheet, belong in the script output and [UI System](../../packages/ui/system/ui-system.md), not duplicated here.

## Renderer Feature Boundary Enforcement

Renderer feature internals are enforced in two modes:

- `pnpm check:renderer-boundaries:staged` for `pre-commit`
- `pnpm check:renderer-boundaries` for `pre-push` and CI

The script prevents files outside a feature from importing that feature's `services/internal/**` implementation surface. It also prevents ordinary renderer files from reading `window.tutti` directly; window container files pass that preload API into feature registrations instead.

## Electron Runtime Boundary Enforcement

Electron runtime import boundaries are enforced in two modes:

- `pnpm check:electron-runtime-boundaries:staged` for `pre-commit`
- `pnpm check:electron-runtime-boundaries` for `pre-push` and CI

The script walks the runtime import graph reachable from `apps/desktop/src/main/**` and `apps/desktop/src/preload/**`.
It rejects:

- React or `.tsx` modules leaking into Electron runtime execution paths
- externalized workspace packages that still resolve to raw source files instead of runnable JS

The script also emits fix-oriented suggestions such as using a narrower non-UI subpath or adding the package to the Electron bundling exclude list when that is the intended runtime seam.

## Agent GUI Degradation Enforcement

The agent GUI degradation ratchet is enforced in two modes:

- `pnpm check:agent-gui-degradation:staged` for `pre-commit`, blocking new
  degradation patterns (uncommented timers, swallowed catches, stores created
  in component files, new provider behavior branches, direct
  `useSyncExternalStore` calls, module-level mutable globals) on staged added
  lines under `packages/agent/gui` and `packages/agent/activity-core`
- `pnpm check:agent-gui-degradation` for `check:full`, pull-request CI, and a
  `check:changed` lane selected when files under `packages/agent/` or
  `tools/degradation-baseline/` change; it compares entropy metrics against
  the committed baseline and fails on any increase, and on any decrease that
  is not locked in by updating the baseline in the same change

Details of the metrics and baseline mechanism live in
[Static Analysis](static-analysis.md).
