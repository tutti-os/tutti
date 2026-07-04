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
- `pnpm check:golangci-version`
- `pnpm lint`
- `pnpm lint:ts`
- `pnpm lint:go`
- `pnpm typecheck`
- `pnpm check:codexproto-generated`

`pnpm check:full` remains the full local and CI validation command and includes linting and typechecking.

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

Renderer feature implementation boundaries are checked by `pnpm check:renderer-boundaries`.
That check also enforces the Workbench-specific rule that
`workspace-workbench/ui/**` imports public service or controller seams instead
of `workspace-workbench/services/internal/**`.

`pnpm check:ui-boundaries` has a package-scoped temporary migration exception
for `packages/agent/gui` while the carried agent activity renderer is
being ported into tutti. During that migration the package may keep its
existing local SVG and icon-library imports, but new reusable icons and
design-system primitives should still move through `@tutti-os/ui-system`
before being shared elsewhere. Remove or replace the package-wide exception
once the carried renderer no longer duplicates its original UI asset tree.

Desktop user-visible copy and locale resources are checked by `pnpm check:i18n`.

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

- `packages/appcli/core`
- `packages/workspace/files`
- `packages/workbench/service`
- `services/tuttid`

The shared lint configuration currently lives in `services/tuttid/.golangci.yml`.

The shared agent daemon runtime under `packages/agent/daemon` is still linted
by `pnpm lint:go`.
During the migration, selected historical files carry file-local
`revive:disable:file-length-limit` comments. New tutti-owned daemon
service/API code should stay outside those exceptions and must continue to
satisfy the normal Go lint baseline.

Changed-aware Go validation includes the nested `packages/agent/daemon` module.
Codex app-server protocol changes should also run
`pnpm check:codexproto-generated` when schema, generator, or generated protocol
files are touched.

Local runs expect a `golangci-lint` binary on `PATH`. The repository pins the CI version through `services/tuttid/.golangci-lint-version`.

If you plan to run `pnpm lint:go` or `pnpm check:full` locally, install `golangci-lint` first and keep it available on `PATH`.

Use `pnpm check:golangci-version` when you only want to verify that the installed binary matches the repository pin without running the broader setup checks.

Recommended local install command, using the pinned repository version:

```sh
pnpm install:golangci-lint
```

This follows the current official binary-install guidance from golangci-lint and keeps local runs aligned with the version pinned for CI.

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
