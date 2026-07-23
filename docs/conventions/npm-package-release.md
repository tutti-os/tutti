# npm Package Release

This document defines the durable release conventions for public npm packages in
this repository.

## Scope

The npm package release flow covers public packages intended for consumption
outside this repository.

All public npm packages in this repository publish under the npm organization
scope `@tutti-os`. Do not introduce new public packages under a different
scope, personal scopes, or unscoped names unless this document and the release
automation are updated together.

The current fixed release group is:

```text
@tutti-os/event-stream-core
@tutti-os/workspace-file-manager
@tutti-os/workspace-file-reference
@tutti-os/workspace-issue-manager
@tutti-os/workspace-user-project
@tutti-os/workspace-app-center
@tutti-os/workspace-external-core
@tutti-os/workspace-terminal
@tutti-os/agent-activity-core
@tutti-os/agent-gui
@tutti-os/claude-sdk-sidecar
@tutti-os/browser-node
@tutti-os/workspace-file-preview
@tutti-os/workbench-snapshot
@tutti-os/workbench-host
@tutti-os/workbench-launchpad
@tutti-os/workbench-surface
@tutti-os/app-release-tools
@tutti-os/auth-bridge
@tutti-os/ui-i18n-runtime
@tutti-os/ui-notifications
@tutti-os/ui-rich-text
@tutti-os/ui-react-hooks
@tutti-os/ui-system
```

These packages use one shared version number and are released together. Do not
introduce independent package versions until there is a clear compatibility need
and a migration plan.

This document covers public npm packages only. Shared non-npm modules such as
`packages/workspace/files` follow their owning language and module conventions
and are not part of the npm release flow unless a separate release contract is
defined for them.

This document is the durable source of truth for which workspace packages
participate in the npm release flow. Do not duplicate the participating package
roster in architecture docs.

This document does not cover the desktop app release flow. Desktop releases are
defined in [Desktop Release](./desktop-release.md).

## Stable Releases

Stable package releases use one manual GitHub Actions workflow dispatch on
`main`.

Each stable run resolves the next shared package version from the latest
existing stable package tag. Stable versions are limited to `0.0.x` during this
iteration:

- if there is no prior stable package tag, the workflow publishes `0.0.1`
- if the latest stable package tag is `packages-v0.0.7`, the next run publishes
  `0.0.8`
- if any existing `packages-v*` tag is outside the `0.0.x` line, the workflow
  must fail rather than guessing

The workflow applies the resolved version to the fixed release group inside the
CI checkout, validates tarballs, and prepares a release-only commit. In that
commit, internal Go module requirements use the resolved shared version and
workspace-relative replacements are removed. The workflow publishes the npm
packages with the `latest` dist-tag, then points the matching npm release tag
and every `packages/**/go.mod` module tag at that release commit. The commit is
reachable through those tags only and is not pushed to `main`. Stable releases
do not open version PRs and do not require Changeset files.

Because the stable release version is applied only in CI, repository manifests
on `main` may lag behind the latest published `0.0.x` version. The durable
release history is the sequence of `packages-v0.0.x` git tags plus the
published npm versions.

When the participating package roster changes, keep these release surfaces
aligned with this document:

- `/.changeset/config.json`
- `package.json` package release scripts
- `tools/scripts/apply-ci-package-release-version.mjs`
- `tools/scripts/check-package-packs.mjs`
- `tools/scripts/next-package-release-version.mjs`
- `tools/scripts/release-beta.mjs`
- `tools/scripts/publish-packages.mjs`

The npm package release workflow should be triggered manually only after the
target package changes have already landed on `main`.

Stable package tags use this shape:

```text
packages-v0.0.1
```

Do not reuse desktop release tags such as `tutti-desktop-v*` for npm packages.

Go module tags for modules under `packages/` are created during the same stable
release and use the Go submodule tag shape:

```text
packages/workbench/service/v0.0.1
packages/appcli/core/v0.0.1
packages/workspace/files/v0.0.1
packages/workspace/issues/v0.0.1
```

Adding a new `packages/**/go.mod` opts that module into this shared stable
package release tag sequence. Do not add package Go modules that require an
independent release cadence unless this convention and the release automation
are updated together.

## Local Beta Releases

Use local beta releases for temporary cross-repository or external integration
debugging.

The local command is:

```bash
pnpm release:beta
```

The beta command publishes the fixed package group with the `beta` dist-tag and
a unique prerelease version such as:

```text
0.1.1-beta-20260521143012
```

The command must not publish to `latest`, create git tags, or commit files. It
must restore temporary package manifest changes before it exits.

Install beta packages explicitly:

```bash
pnpm add @tutti-os/browser-node@beta
pnpm add @tutti-os/workspace-file-reference@beta
pnpm add @tutti-os/workspace-file-preview@beta
pnpm add @tutti-os/workspace-file-manager@beta
pnpm add @tutti-os/workspace-issue-manager@beta
pnpm add @tutti-os/workspace-app-center@beta
pnpm add @tutti-os/workspace-terminal@beta
pnpm add @tutti-os/workbench-host@beta
pnpm add @tutti-os/workbench-surface@beta
pnpm add @tutti-os/workbench-snapshot@beta
pnpm add @tutti-os/ui-i18n-runtime@beta
pnpm add @tutti-os/ui-notifications@beta
pnpm add @tutti-os/ui-rich-text@beta
pnpm add @tutti-os/ui-react-hooks@beta
pnpm add @tutti-os/ui-system@beta
```

Do not add a second stable release path that bypasses the shared package roster
or the stable tag sequence.

## Package Shape

Published packages build into `dist` and expose built artifacts through package
exports. Do not expose `src/*` as public npm API.

Inside the workspace, package manifests may point `exports` and `types` at
`src` so local development does not require a package build before every
typecheck or desktop dev run. Use `publishConfig` to override those fields to
`dist` when pnpm packs or publishes the package.

Published packages should include:

- `dist`
- `README.md`
- `package.json`

Published packages should not include:

- `src`
- package-local `tsconfig.json`
- package-local build config
- generated junk files

Packages that expose Tiptap runtime objects or types must declare their shared
Tiptap runtime packages as peer dependencies, with the same ranges repeated as
development dependencies for workspace builds. Tiptap packages require exact
peer versions, so component-internal extensions must be bundled from development
dependencies rather than resolved independently in the consumer. A
package-private copy of the shared runtime can make structurally identical
extensions type-incompatible in consumers.

Runtime assets that are rendered or referenced by public entrypoints must also
survive the packed package shape. When a public runtime entrypoint such as
`./workbench` or `./ui` renders a package-local image, icon bitmap, schema, or
similar asset, keep the main runtime entrypoint asset-free whenever possible.
Prefer an explicit public asset subpath such as
`./assets/workspace-dock-website.png`, let the business consumer import that
asset only when it actually uses the default visual, and ship the asset file
through an explicit package build rule.

Use this command to inspect publish contents:

```bash
pnpm release:pack:check
```

Before publishing a package that exposes runtime assets, verify all of the
following:

- `pnpm release:pack:check` shows the packed output that consumers will install
- the packed tarball includes every exported asset subpath such as
  `./dist/assets/workspace-dock-website.png`
- the main runtime entrypoint no longer hard-depends on a package-local image
  unless that dependency is an intentional part of the public contract
- a consumer-facing build emits or copies the asset only when the consumer
  explicitly imports the asset subpath
- packed JavaScript does not contain raw XML SVG data URLs or bare relative SVG
  strings; SVGs interpolated into runtime CSS `url(...)` values must use a
  CSS-safe data URL or an absolute URL constructed relative to the module
- every asset referenced through `new URL(relativePath, import.meta.url)` exists
  at that exact module-relative location inside the packed tarball
- published code that may be dependency-prebundled must import fallback images
  through explicit public asset subpaths; do not leave
  `new URL("./assets/...", import.meta.url)` in a bundled runtime entrypoint,
  because a consumer optimizer may relocate the JavaScript without relocating
  the adjacent asset

Emitting an SVG next to a bundled JavaScript file is not sufficient when the
bundle only exports a string such as `./icon-HASH.svg`. CSS resolves that value
relative to the consuming page, and consumer bundlers cannot discover the
runtime string as an asset dependency.

Do not use a workspace application build as the only validation for asset
changes. Workspace exports can point at source while published exports point at
`dist`, so the two paths may apply different asset transforms. The packed
tarball is the consumer contract.

## Package Entrypoints

The stable package entrypoints are:

```text
@tutti-os/agent-activity-core
@tutti-os/agent-gui
@tutti-os/agent-gui/agent-conversation
@tutti-os/agent-gui/agent-env
@tutti-os/agent-gui/agent-env-ui
@tutti-os/agent-gui/agent-message-center
@tutti-os/agent-gui/context-mention-palette
@tutti-os/agent-gui/i18n
@tutti-os/agent-gui/styles.css
@tutti-os/agent-gui/workbench
@tutti-os/agent-gui/workbench/browser-element-context
@tutti-os/agent-gui/workbench/tool-sidebar
@tutti-os/agent-gui/workspace-settings-panel
@tutti-os/browser-node
@tutti-os/browser-node/assets/workspace-dock-website.png
@tutti-os/browser-node/bridge
@tutti-os/browser-node/chrome-cookie-import/macos
@tutti-os/browser-node/electron-main
@tutti-os/browser-node/electron-preload
@tutti-os/browser-node/electron-renderer
@tutti-os/browser-node/i18n
@tutti-os/browser-node/react
@tutti-os/browser-node/workbench
@tutti-os/ui-i18n-runtime
@tutti-os/ui-notifications
@tutti-os/ui-rich-text
@tutti-os/ui-rich-text/core
@tutti-os/ui-rich-text/editor
@tutti-os/ui-rich-text/plugins
@tutti-os/ui-rich-text/types
@tutti-os/ui-react-hooks
@tutti-os/workspace-app-center
@tutti-os/workspace-app-center/contracts
@tutti-os/workspace-app-center/core
@tutti-os/workspace-app-center/i18n
@tutti-os/workspace-app-center/ui
@tutti-os/workspace-file-preview
@tutti-os/workspace-file-preview/core
@tutti-os/workspace-file-preview/react
@tutti-os/workspace-file-manager
@tutti-os/workspace-file-manager/assets/workspace-archive-fallback.png
@tutti-os/workspace-file-manager/assets/workspace-folder-fallback.png
@tutti-os/workspace-file-manager/services
@tutti-os/workspace-file-reference
@tutti-os/workspace-file-reference/contracts
@tutti-os/workspace-file-reference/core
@tutti-os/workspace-file-reference/react
@tutti-os/workspace-file-reference/ui
@tutti-os/workspace-issue-manager
@tutti-os/workspace-issue-manager/assets/workspace-dock-task.png
@tutti-os/workspace-issue-manager/contracts
@tutti-os/workspace-issue-manager/core
@tutti-os/workspace-issue-manager/i18n
@tutti-os/workspace-issue-manager/openapi/issue-manager.v1.yaml
@tutti-os/workspace-issue-manager/services
@tutti-os/workspace-issue-manager/ui
@tutti-os/workspace-issue-manager/workbench
@tutti-os/workspace-user-project
@tutti-os/workspace-user-project/contracts
@tutti-os/workspace-user-project/core
@tutti-os/workspace-user-project/i18n
@tutti-os/workspace-user-project/ui
@tutti-os/workspace-terminal
@tutti-os/workspace-terminal/contracts
@tutti-os/workspace-terminal/i18n
@tutti-os/workspace-terminal/react
@tutti-os/workspace-terminal/styles.css
@tutti-os/workspace-terminal/workbench
@tutti-os/workbench-snapshot
@tutti-os/workbench-snapshot/schema.json
@tutti-os/workbench-host
@tutti-os/workbench-host/conformance
@tutti-os/workbench-surface
@tutti-os/workbench-surface/i18n
@tutti-os/workbench-surface/styles.css
@tutti-os/ui-system
@tutti-os/ui-system/components
@tutti-os/ui-system/dev-vite
@tutti-os/ui-system/icons
@tutti-os/ui-system/metadata
@tutti-os/ui-system/styles.css
@tutti-os/ui-system/utils
```

New public subpaths should be added only when a real consumer needs them.

`@tutti-os/ui-system/dev-vite` is a development-tooling subpath for external Vite
consumers. It is part of the package release surface so external projects can
configure local source sync without manual linking, but it must not be imported
from application runtime code.

`@tutti-os/ui-system/metadata` is a tooling metadata subpath used by the
storyboard, dev server, and agent skills. It should describe stable public
exports rather than exposing private source layout as the consumer API.

## Review Guidance

When reviewing package extraction or release-surface changes, keep these rules
separate:

- `packages/*` still exists for real shared seams rather than for code that only
  looks reusable.
- a public npm package is an explicit external contract and may be valid even
  before there are two in-repository consumers
- when a package does not yet have a second in-repository host, the PR should
  make the intended external contract and release ownership explicit rather than
  treating publishability as implied
- shared non-npm modules such as `packages/workspace/files` should not be counted
  as public npm packages unless they are added to this document and the release
  configuration

## CSS Boundary

`@tutti-os/ui-system` owns shared tokens, theme styles, and primitive styles. Other
reusable packages should consume UI system primitives and token-backed Tailwind
utilities before introducing package-local CSS.

Reusable packages should not publish their own stylesheet entrypoint by default.
Prefer React components and Tailwind utilities that resolve through the
consumer's Tailwind build and the shared UI system token layer.

The current stylesheet entrypoint exceptions are explicit package contracts:

- `@tutti-os/agent-gui/styles.css` for the carried agent GUI,
  session chrome, session transcript, and workspace-agent status panel
  selectors that remain package-owned during the migration
- `@tutti-os/workbench-surface/styles.css` for surface layout, window frames,
  resize handles, snap previews, and dock/chrome positioning
- `@tutti-os/workspace-terminal/styles.css` for the terminal node structural
  shell, close guard, and xterm host container selectors

Tailwind consumers should include reusable packages in their source scan when
they consume packages that render Tailwind utility classes. For example:

```css
@source "../node_modules/@tutti-os/workbench-surface/dist";
```

For monorepo packages that render runtime Tailwind utility classes, declare the
source root in `package.json` so repository checks can enforce consumer setup:

```json
{
  "tutti": {
    "tailwindSourceRoot": "src"
  }
}
```

Desktop renderer consumers should then add the matching package source path to
their Tailwind entrypoint. `pnpm check:ui-boundaries` validates this for
workspace packages imported by `apps/desktop`, including mismatched `@source`
paths that point at the wrong directory.

Package-local CSS should be rare. Add it only when a reusable package needs
selectors, keyframes, or structure that is awkward to express through primitives
and Tailwind utilities. When package-local CSS is necessary, it must use UI
system tokens and must not contain app-specific product styling or user-visible
copy.

Published stylesheet sources use standard CSS properties. In particular,
author `backdrop-filter` without a handwritten `-webkit-backdrop-filter` pair.
The consuming application's CSS build owns browser-target prefix generation;
the packed stylesheet does not promise a second, package-owned legacy-browser
prefixing pass. Consumer production builds should assert that optimization did
not leave prefix-only declarations.

Do not add a public `./styles.css` export for a reusable package unless that CSS
is genuinely part of the package's stable contract. If the same need would help
multiple packages, add the token, primitive, or utility support to
`@tutti-os/ui-system` instead.

## Access And Credentials

All scoped public packages must set public access through package
`publishConfig.access`.

Stable publishing should prefer npm trusted publishing through GitHub Actions
OIDC. If a token fallback is needed, use only a GitHub Actions secret and keep it
out of local scripts.

When the workflow uses an `NPM_TOKEN` fallback, that token must belong to an
npm account with publish access to the `@tutti-os` organization scope.

Local beta publishing uses the developer's local npm login.

## Validation

For changes that affect published package surfaces, run:

```bash
pnpm lint:ts
pnpm typecheck
pnpm check:ui-boundaries
pnpm release:pack:check
```

For shared UI export or CSS boundary changes, keep `pnpm check:ui-boundaries`
aligned with package exports and allowed style locations.
