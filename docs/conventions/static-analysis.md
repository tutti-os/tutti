# Static Analysis

This document defines the repository-managed static analysis baseline.

## Purpose

Static analysis should catch:

- common correctness issues in TypeScript and Go
- repository boundary violations that are cheap to detect mechanically
- oversized business files before they become long-term maintenance hotspots

It should not:

- turn formatting concerns already handled by Oxfmt, Prettier, or `gofmt` into duplicate failures
- enforce broad stylistic preferences with weak product value
- apply business-file limits to tests, generated code, or type-only surfaces

## Commands

Repository entrypoints:

- `pnpm setup:dev`
- `pnpm check:backdrop-filter-authoring`
- `pnpm check:golangci-version`
- `pnpm lint`
- `pnpm lint:ts`
- `pnpm lint:go`
- `pnpm typecheck`
- `pnpm check:codexproto-generated`
- `pnpm check:agent-gui-provider-catalog-generated`
- `pnpm check:agent-host-boundary`
- `pnpm check:agent-provider-strategy-boundaries`

`pnpm check:full` remains the full local validation command and includes
linting, typechecking, repository checks, and blocking tests. PR CI selects the
equivalent affected surfaces instead of running `check:full` as one job.

The pull-request workflow and `check:changed` share changed-file classification
from `tools/scripts/change-classification.mjs` and repository-check ownership
from `tools/scripts/repository-checks.mjs`. Repository checks are grouped by
responsibility: policy, tool contracts, generated contracts, and architecture
boundaries. TypeScript and Go jobs own language lint/tests only; a check written
in TypeScript does not make it a TypeScript check. Package sources and assets
select packing independently of language. Documentation-only changes skip code
validation while still producing workflow check results through job-level
conditions. Do not use workflow-level `paths-ignore` for this gate because
missing required checks can leave documentation-only PRs waiting on branch
protection.

PR CI keeps the existing `Tooling Consistency` required context as the owner of
repository policy, contract, generated, and boundary checks. This preserves
branch-protection compatibility while keeping those checks out of language
jobs.

Validation runners that spawn nested pnpm commands should read the root
`packageManager` field and invoke that pinned version through Corepack. Do not
let runner-spawned lanes resolve a bare `pnpm` from `PATH`, because local
package-manager shims can differ from the repository pin.

Tests and checks that create temporary Git repositories must also isolate
repository-local Git environment variables before invoking Git. In particular,
remove inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, index/object
overrides, and command-scoped `GIT_CONFIG_*` entries using case-insensitive
name matching for Windows compatibility; set
`GIT_CEILING_DIRECTORIES` to the fixture root; fail immediately when fixture Git
commands fail; and verify the initialized Git directory before staging,
committing, fetching, or checking out. A temporary cwd alone is not isolation
because `GIT_DIR` takes precedence and can redirect `git init` and later
commands into a caller's linked-worktree metadata.

## TypeScript Baseline

TypeScript linting uses Oxlint.

The current baseline includes:

- Oxlint correctness checks
- `noUncheckedIndexedAccess` in the shared TypeScript base config

Generated TypeScript is not linted by the human-authored TypeScript rule set. Generated output should be controlled through its generator and generation checks instead of hand-edited to satisfy repository lint style.

Generated Codex app-server protocol artifacts under
`packages/agent/daemon/runtime/codexproto` are checked by
`pnpm check:codexproto-generated`. The check fetches the pinned Codex source
commit, compares the committed upstream schema snapshot as canonical JSON,
reruns the local Go generator, and fails when generated files drift. The schema
comparison intentionally ignores JSON formatting differences so vendored
upstream artifacts can coexist with repository Prettier formatting. Do not
hand-edit generated `*_gen.go` files; update the vendored schema or generator,
then regenerate.

The codexproto generator runs during `pnpm check:full` alongside full-repository
boundary scanners. Generator scratch files must stay outside the repository
tree, even when they are removed before the generator exits, so parallel checks
cannot observe transient files and fail nondeterministically.

The Agent GUI provider identity catalog under
`packages/agent/gui/generated/providerIdentityCatalog.ts` is generated from the
daemon provider registry. `pnpm check:agent-gui-provider-catalog-generated`
fails when the checked-in TypeScript catalog drifts from the descriptor source
of truth, when a generated locale key is absent from any AgentGUI locale, or
when a generated icon key has no complete asset set. The same check also keeps
the descriptor set equal to closed OpenAPI provider-keyed preference schemas
while verifying that `AgentTargetProvider` and `WorkspaceAgentProvider` remain
open, bounded identifier contracts that accept extension providers. It runs as part of
`pnpm check:full`. Change provider identity, locale keys, icons, and target metadata in the registry, then run
`pnpm generate:agent-gui-provider-catalog`; do not hand-edit the generated
catalog.

Provider strategy is an independent architecture boundary enforced by
`pnpm check:agent-provider-strategy-boundaries`. Cross-provider daemon, service,
and desktop production code must dispatch behavior through
`providerregistry` strategy, capability, and integration descriptors instead
of branching on Codex, Claude, Cursor, Hermes, Nexight, OpenClaw, OpenCode, or
Tutti Agent identity. The checker reads the complete provider ID set from the
daemon registry and rejects identity constants, literal equality comparisons,
literal switch cases, and provider-specific Set or array membership dispatch in
Go, TypeScript, and TSX production sources. Plain provider catalogs and enum
validation remain allowed when they do not select behavior.
It keeps an explicit exemption list for registry declarations, generated API
enums, and exact provider-owned adapter/parser implementations (including
format-specific external-import parsers); additions to that list require an
ownership reason and must not hide cross-provider policy.
Its fixture suite must exercise every registered provider so a newly migrated
provider cannot silently remain outside the boundary rule.

Historical or ported-source snapshots that are intentionally kept outside a
package's active `tsconfig.json` during migration should also stay out of the
type-aware TypeScript lint target. Treat those directories as migration inputs,
not as first-class analyzed source, until they are promoted into the active
package seam.

`exactOptionalPropertyTypes` is intentionally not part of the shared TypeScript baseline yet. The current generated `@hey-api/client-fetch` runtime emits optional properties with explicit `undefined` values that do not typecheck under that option, and the available generator settings do not remove those conflicts. Revisit this after changing the generator version or generated-client strategy.

Every TypeScript workspace package that contains source files should provide:

- a package-local `tsconfig.json` extending the repository TypeScript base config
- a package-local `typecheck` script that runs the repository `tsgo` typecheck wrapper

This keeps `pnpm typecheck` authoritative across desktop, shared clients, contracts, and UI packages instead of relying on incidental imports from another package to expose type errors.

The wrapper runs native TypeScript with `--noEmit --incremental` and stores
package `.tsbuildinfo` files under `.tmp/tsbuildinfo`. This keeps warm local
typecheck runs fast without committing cache files.

The root `pnpm typecheck` command uses a compact runner that executes package
typechecks concurrently, prints only a short summary on success, and stores
package logs under `.tmp/typecheck-runs`.

TypeScript package `tsconfig.json` files must not use `baseUrl`; use explicit relative `paths` entries when aliases are needed so the configuration stays compatible with native TypeScript.

The repository-specific UI boundary policy remains in `pnpm check:ui-boundaries`.

## Backdrop Filter Build Contract

Production CSS and Tailwind arbitrary-property authoring under `apps/`,
`packages/`, and `services/` must use the standard `backdrop-filter` property.
Do not handwrite `-webkit-backdrop-filter`: Tailwind/Lightning CSS owns
target-aware prefix generation, and duplicate declarations can be folded into a
prefix-only result during production optimization.

`pnpm check:backdrop-filter-authoring` enforces the source rule. Desktop builds
also run `tools/scripts/verify-renderer-css-contracts.mjs` against final renderer
assets. The artifact gate permits standard-only output or a generated prefix
followed by the standard property; it rejects prefix-only output, reversed
ordering, and a launchpad dismiss layer without a non-`none` standard filter.
The React `WebkitBackdropFilter` inline-style property is outside this stylesheet
optimization boundary and is not rejected by the authoring check.

Renderer feature implementation boundaries are checked by `pnpm check:renderer-boundaries`.
That check also enforces the Workbench-specific rule that
`workspace-workbench/ui/**` imports public service or controller seams instead
of `workspace-workbench/services/internal/**`.
Workspace Workbench launch coordinators must also route workspace-keyed Shell
registrations through the private `WorkspaceScopedRegistrationRegistry` rather
than declaring their own `Map`. The rule covers top-level
`*LaunchCoordinator.ts` services and the Message Center coordinator, while
leaving non-launch coordinator state such as Agent GUI open-session reference
counts outside this registration-specific policy. Because the rule is part of
`check:renderer-boundaries`, it runs for staged renderer changes, the
renderer-boundary lane selected by `check:changed`, and `check:full`. Changes
to the renderer-boundary checker or its fixture suite also select that
`check:changed` lane, so policy edits validate both their fixtures and the live
renderer tree.

`pnpm check:ui-boundaries` has a package-scoped temporary migration exception
for `packages/agent/gui` while the carried agent activity renderer is
being ported into tutti. During that migration the package may keep its
existing local SVG and icon-library imports, but new reusable icons and
design-system primitives should still move through `@tutti-os/ui-system`
before being shared elsewhere. Remove or replace the package-wide exception
once the carried renderer no longer duplicates its original UI asset tree.

Desktop user-visible copy and locale resources are checked by `pnpm check:i18n`.

`pnpm check:agent-activity-runtime-boundaries` scans Agent GUI and desktop
renderer production code. Agent activity commands must go through
`AgentActivityRuntime`; session-engine consumers must use exported selectors
instead of reading `sessionsById`, `turnsById`, `interactionsById`, pending
intent maps, or prompt-queue records directly. Entity storage keys and reducer
layout are engine implementation details, not consumer contracts. The check
also rejects the deleted `workspaceAgentActivityTypes` aggregate, handwritten
session/snapshot/presence mirrors, module-global runtime resolver access, and
deprecated session lifecycle reads. The desktop reconcile diagnostics module
has a narrow serialization-only exception for legacy lifecycle evidence.
Direct React external-store subscription enforcement follows the actual
`useSyncExternalStore(...)` argument dependency: an argument that directly or
indirectly resolves to `getSessionEngine(...)` is rejected, while another store
subscription in a file that separately reads the engine is allowed. Keep both
the passing unrelated-store fixture and failing direct-engine fixture when this
analysis changes; file-level token coexistence is not a valid substitute for
the call relationship.

`pnpm check:changed` schedules this activity-runtime boundary lane whenever a
change touches `packages/agent/gui`, `packages/agent/activity-core`, Desktop's
`workspace-agent` or `workspace-workbench` features, or the checker/fixture
implementation itself. This keeps the same boundary in the normal changed-file
loop instead of discovering violations only in `check:full`.

`pnpm check:agent-host-boundary` protects the Agent Host boundary. Agent
application-core lifecycle semantics (session/turn/goal/runtime-operation
creation, sendability, terminal state, recovery) belong to
`packages/agent/host`; `services/tuttid/service/agent` is an adapter that
delegates through `ApplicationHost()`. The check scans production (non
`_test.go`) Go files under `services/tuttid/service/agent` and rejects new
`*Coordinator`, `*Worker`, or `*Actor` orchestration surfaces, detected as a
type declaration whose name ends in one of those words or a file whose name
ends in `_coordinator.go`, `_worker.go`, or `_actor.go`. It is a ratchet: the
`ALLOWLIST` in the checker is the current snapshot (only
`composer_live_model_coordinator.go`, a provider-catalog adapter concern), may
only shrink, and rejects stale entries whose files no longer exist. A new
violation fails until the orchestration moves to `packages/agent/host` or the
file is added to `ALLOWLIST` with a reviewed ownership reason. The rule runs in
`pnpm check:full`, in the `check:changed` `boundary:agent-host` lane whenever a
change touches `services/tuttid/service/agent` or the checker/fixture itself,
and in the PR `go-lint` job. The boundary rationale and adapter rules live in
the root `AGENTS.md` `Agent Host Boundary` section and
`services/tuttid/service/agent/AGENTS.md`.

The same check also verifies production reachability: `services/tuttid/wiring.go`
must compose Host with `daemon/hostadapter.RuntimeController`,
`host.SQLiteWorkspaceStore`, and `NewApplicationHostWithPorts`. This prevents
shared lifecycle adapters from existing only in tests while production keeps a
parallel service implementation. Production agent service files also reject
service-local `serviceHostStore` / `serviceHostRuntime` composition and lazy
`NewApplicationHost` factories; isolated in-memory adapters may exist only in
`_test.go` fixtures.

## Agent GUI Degradation Ratchet

The agent GUI refactor
([docs/architecture/agent-gui-refactor-plan.md](../architecture/agent-gui-refactor-plan.md))
is protected by a degradation ratchet:

- `pnpm check:agent-gui-degradation` measures entropy metrics over
  `packages/agent/gui` and `packages/agent/activity-core` (per-file line counts
  over the business limit, package-wide effect totals, per-component
  memoization overages, render-time ref mirrors/caches, provider behavior
  branches, timers, swallowed catch blocks, view-embedded stores, direct
  `useSyncExternalStore` calls, module-level mutable globals, and daemon Go
  file-length exemptions) and compares them against the committed baseline in
  `tools/degradation-baseline/agent-gui.json`. Render-mirror counting also
  covers Desktop's `DesktopAgentGUIWorkbenchBody` host boundary because
  unstable host callbacks can invalidate the entire Agent GUI subtree.
- Effect counts remain package-wide because hooks move with a vertical module
  during decomposition. Memoization follows the architecture boundary instead:
  `.tsx` component modules have a five-call budget, while controller/read hooks
  may own stable projections. Read-layer memoization must stabilize data-owner
  output; it must not become a second view cache.
- Any metric increase fails. Any decrease also fails until the same change
  updates the baseline with
  `node tools/scripts/check-agent-gui-degradation.mjs --update-baseline`, so
  refactor wins stay locked in.
- The metric counting rules live in the script; numbers quoted in architecture
  documents are illustrative only.
- `identityExemptFiles` in the baseline lists identity-display files (provider
  icons, labels, title projections) whose provider branches are tracked in a
  separate bucket. The list may only shrink, and the checker rejects entries
  whose files no longer exist so removed seams cannot leave permanent stale
  exemptions.
- `pnpm check:agent-gui-degradation:staged` runs in `pre-commit` and blocks
  new degradation patterns on staged added lines: uncommented timers (a
  `// timing: <reason>` comment is required outside engine/reducer/selector
  code, where timers are forbidden entirely), silently swallowed catch blocks,
  component memoization beyond budget, render-time ref mirrors/caches, store
  creation in component files, new provider behavior branches, direct
  `useSyncExternalStore` calls outside the single engine binding file, and new
  module-level mutable globals. Ref-mirror and component-cache diagnostics
  explicitly route business state to the engine/controller and stable
  projections to selectors/read hooks; refs remain valid for imperative DOM,
  timer, abort, and external-lifecycle handles.
- During a merge commit, staged mode compares the resolved index with
  `MERGE_HEAD` instead of treating every incoming-parent line as newly added.
  This keeps the hook focused on branch-authored degradation while the full
  baseline check still measures the complete merged tree.

The business file size limit below also applies to TypeScript under
`packages/agent/gui` and `packages/agent/activity-core` through this ratchet:
files over the limit that are not in the baseline fail the check, and
baselined files may not grow.

Render budget tests are the companion mechanism for performance work: the
probe utility in `packages/agent/gui/shared/testing/renderBudget.tsx` asserts
React commit counts for typical interactions, and budget test cases are
delivered with each feature-module slice.

Fix-scope is soft-gated in pull-request CI by
`tools/scripts/check-fix-scope.mjs`: a fix-titled PR changing more than 300
implementation lines must answer "what is the root cause" and "why can this
not be fixed at a lower layer" in the PR description. The count excludes docs,
tests, fixtures, snapshots, and generated artifacts so the gate stays focused
on production fix surface area.

Electron `main` and `preload` runtime import graphs are checked by `pnpm check:electron-runtime-boundaries`.
That script is intentionally narrow: it ignores type-only imports and test files, then follows reachable runtime imports to catch React/TSX leaks and Electron-externalized workspace packages that still resolve to raw source files.

The i18n check enforces:

- locale key parity across supported desktop locales
- interpolation placeholder parity across locale values
- valid references for literal i18n keys used from desktop code
- likely hardcoded user-visible copy in desktop renderer and Electron UI surfaces

The i18n check discovers locale-resource modules through manifest exports
instead of a central script-side registry. Desktop-owned resources use
`tuttiI18nModule`; reusable packages may use a package-specific manifest name
when that keeps the package vocabulary product-neutral, such as
`browserNodeI18nModule` or `agentGuiI18nModule`.

Prefer constructing that manifest through the shared helpers exported from
`@tutti-os/ui-i18n-runtime`:

- `createLocaleObjectI18nModuleManifest(...)`
- `createScopedLocaleObjectsI18nModuleManifest(...)`

Current manifest modes:

- `locale-object`
  Use this when a module owns top-level locale files such as
  `locales/en.ts` and `locales/zh-CN.ts`.
- `scoped-locale-objects`
  Use this when a reusable package owns a scoped default dictionary under one
  namespace and the host merges that package resource into the app-level i18n
  runtime.

Current manifest expectations:

- desktop-owned locale resources should expose a manifest from
  `apps/desktop/src/shared/i18n/*`
- reusable package default i18n resources should expose a manifest from the
  owning package source tree under `packages/*`
- reusable package `scoped-locale-objects` manifests should include:
  `name`, `namespace`, `sourceRoot`, and `localeObjectByLocale`
- desktop or package `locale-object` manifests should include:
  `name` and `fileByLocale`; package-owned `locale-object` manifests should
  also include `sourceRoot`

When adding a new reusable package that owns default i18n resources, do all of
the following in the same change:

- keep the default resource in the owning package instead of copying it into
  `apps/desktop`
- export an i18n manifest next to that package's i18n resource
- merge the package resource into the desktop app-level i18n runtime when the
  desktop host consumes that package
- run `pnpm check:i18n`

## Go Baseline

Go linting uses `golangci-lint` across the repository's current Go modules.
The current root entrypoint runs the linter from:

- `packages/agent/activity-replication`
- `packages/agent/host`
- `packages/agent/store-sqlite/canonical`
- `packages/appcli/core`
- `packages/agent/runtimeprep`
- `packages/workspace/files`
- `packages/workbench/service`
- `services/tuttid`

The shared lint configuration currently lives in `services/tuttid/.golangci.yml`.

The shared agent daemon runtime under `packages/agent/daemon` is included by
changed-aware Go lint when daemon files change, but is not yet part of the root
`pnpm lint:go` module list. During the migration, selected historical files carry file-local
`revive:disable:file-length-limit` comments. New tutti-owned daemon
service/API code should stay outside those exceptions and must continue to
satisfy the normal Go lint baseline.

Changed-aware Go validation includes the nested
`packages/agent/activity-replication`, `packages/agent/daemon`,
`packages/agent/host`,
`packages/agent/runtimeprep`, `packages/agent/store-sqlite`, and
`packages/agent/store-sqlite/canonical` modules.
Codex app-server protocol changes should also run
`pnpm check:codexproto-generated` when schema, generator, or generated protocol
files are touched.

Local runs resolve `golangci-lint` from `$(go env GOPATH)/bin` first and fall
back to `PATH`. This matches the repository install command without requiring a
shell-specific `PATH` edit. The repository pins the CI version through
`services/tuttid/.golangci-lint-version`. CI downloads the official installer
to a temporary file with transient-network retries, runs it only after the
download succeeds, and adds the install directory to `PATH` only after verifying
that the pinned binary is executable.

If you plan to run `pnpm lint:go` or `pnpm check:full` locally, install
`golangci-lint` first. A compatible binary already available on `PATH` remains
supported as a fallback.

Use `pnpm check:golangci-version` when you only want to verify that the installed binary matches the repository pin without running the broader setup checks.

Recommended local install command, using the pinned repository version:

```sh
pnpm install:golangci-lint
```

This installs the pinned binary into `$(go env GOPATH)/bin`; repository-managed
setup, version, changed-aware, and full lint commands resolve that location
automatically. It follows the current official binary-install guidance from
golangci-lint and keeps local runs aligned with the version pinned for CI.

The current baseline enables a small, high-value set of linters:

- `errcheck`
- `govet`
- `ineffassign`
- `nolintlint`
- `staticcheck`
- `unused`
- `revive`

In golangci-lint v2, `staticcheck` also covers checks that were previously exposed as separate `gosimple` and `stylecheck` linters.

`nolintlint` keeps lint suppressions explicit and valid when an exception is necessary.

## Business File Size Limit

Business-code files must stay at or below `800` lines.

This limit is a refactoring trigger:

- when a business file exceeds the limit, prefer splitting responsibilities or extracting focused helpers before adding more logic
- do not treat the limit as a suggestion to bypass with casual exceptions

The limit does not apply to:

- test files
- generated files
- pure type declarations
- contracts packages
- bootstrap or helper surfaces outside the configured business paths

Current first-pass scope:

- TypeScript business paths under `apps/desktop/src/main/*`, `apps/desktop/src/preload/*`, and `packages/clients/*`
- Go business paths under `packages/workspace/files/*` and `services/tuttid/app/*`, `api/*`, `biz/*`, `data/*`, `server/*`, and `service/*`

## Workflow Rules

- keep `pre-commit` focused on staged formatting and cheap boundary checks
- keep linting in `pre-push` and pull-request CI through the shared root scripts
- prefer extending the existing lint configs before adding new one-off repository scripts
- add repository-specific scripts only when standard lint tooling cannot express the rule cleanly
