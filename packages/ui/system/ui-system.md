# UI System

This document defines the responsibility boundary for the shared visual-system package under `packages/ui/*`.

## Purpose

The shared UI system package exists to hold product-facing visual foundations that are reused across renderer surfaces.

The current package is:

- `packages/ui/system`

It is organized into two public component layers:

- `base`
  Basic visual primitives and foundations such as tokens, icons, Button,
  Input, Dialog, Select, Card, Badge, and Toast.
- `business`
  Multi-end reusable Tutti business display components. These components may
  expose domain display props such as workspace, file, task, or agent state, and
  should compose `base` primitives instead of recreating them.

The package owns:

- design tokens
- shared theme styles
- icon exports
- presentation primitives
- reusable business display components

It does not own:

- business logic or host-side side effects
- app-specific workflows
- daemon, Electron, router, or host adapter calls

## Current Package Role

`@tutti-os/ui-system` is the single source of truth for:

- CSS token definitions
- structural shared workbench CSS in `packages/workbench/surface/src/styles/workbench.css`
- structural shared terminal CSS in `packages/workspace/terminal/src/styles/terminal.css`
- Tailwind-facing semantic theme variables
- shared SVG and icon APIs
- shadcn-derived React primitives

Desktop renderer code should consume this package instead of defining a second token or primitive layer in `apps/desktop`.

The visual language that this package should serve is defined in [Desktop Visual Language](../../../docs/conventions/desktop-visual-language.md).

## Public API

`@tutti-os/ui-system` should expose a small, stable surface:

- `@tutti-os/ui-system`
  Root runtime entry for shared primitives, icon components, and the small set of utility exports that primitives depend on
- `@tutti-os/ui-system/styles.css`
  Shared stylesheet entry loaded by renderer shells
- `@tutti-os/ui-system/components`
  Stable component barrel for tooling and rare category-focused imports
- `@tutti-os/ui-system/icons`
  Stable icon barrel for tooling and rare category-focused imports
- `@tutti-os/ui-system/utils`
  Stable utility entry for shadcn CLI integration and primitive support code
- `@tutti-os/ui-system/metadata`
  Tooling entry for component metadata used by storyboard, dev server, and
  agent skills
- `@tutti-os/ui-system/dev-vite`
  Development-tooling entry for external Vite apps that opt into local source
  sync; this is not a runtime component API

Default consumption rules:

- application code should prefer importing primitives and icons from `@tutti-os/ui-system`
- renderer entrypoints should import `@tutti-os/ui-system/styles.css` once
- shadcn monorepo aliases may target `@tutti-os/ui-system/components` and `@tutti-os/ui-system/utils`
- application runtime code must not import `@tutti-os/ui-system/dev-vite`
- consumers must not deep import `@tutti-os/ui-system/src/*` or component file
  paths; use the root package and stable subpaths instead

## Automated Enforcement

The repository enforces the shared UI boundary with:

- `pnpm check:ui-boundaries`
- `pnpm check:ui-boundaries:staged`

Use the script output as the source of truth for the mechanically-checkable rules.

- `check:ui-boundaries:staged` is the fast local hook variant for staged files
- `check:ui-boundaries` is the full-repository variant for `pre-push` and CI
- `@tutti-os/workbench-surface/styles.css`, `@tutti-os/workspace-terminal/styles.css`, and `@tutti-os/agent-gui/styles.css` are the only non-UI-system package stylesheets allowed by the boundary check
- `@tutti-os/workbench-surface/styles.css` and `@tutti-os/workspace-terminal/styles.css` should remain structural and variable-driven, not product-branded
- `@tutti-os/agent-gui/styles.css` is a deliberate package contract for the carried agent GUI and workspace-agent panel selectors that still rely on package-owned class names

Keep this check aligned with the package exports and file boundary rules:

- if a new stable public subpath is intentionally added, update both `packages/ui/system/package.json` and the import-check script
- do not "fix" the script by broadening the allowed list unless the package boundary itself is intentionally changing

## Metadata Rules

Every public UI-system metadata entry must have a stable `id`.

- `id` is the user-facing tooling identifier for storyboard anchors, dev server
  metadata, and agent skill lookups
- `id` must be globally unique and use readable kebab-case, for example
  `button`, `dialog-content`, `button-variants`, or `styles-css`
- `id` should not be derived at runtime by consumers; read it from
  `@tutti-os/ui-system/metadata`
- `name` and `export` remain the TypeScript API identity, while `id` is the
  stable human-readable inventory identity
- `layer` must be either `base` or `business`
- `business` components may use business display nouns in their props, but
  should still receive data, labels, status, and callbacks from the consuming
  host

## Component Promotion Protocol

Use this protocol when moving UI from an application or business package into
`@tutti-os/ui-system`.

The UI system follows a shadcn-like self-owned source model:

- Radix or equivalent headless primitives provide accessible interaction
  behavior where a proven primitive exists
- CVA-style variant definitions keep component variants explicit and typed
- Tailwind classes consume shared semantic tokens instead of local palettes
- Tutti owns the checked-in source, public exports, metadata, storyboard
  examples, and boundary validation

Before extracting a component, decide whether the target is `base`, `business`,
or not suitable for UI-system promotion.

Promote to `base` when the component is a foundation primitive:

- it has no product workflow or domain noun in its public contract
- props describe presentation, interaction, accessibility, variants, refs,
  slots, class names, or children
- the component can be reused by unrelated surfaces without explaining a
  business concept
- a known shadcn or Radix primitive can provide the starting point, or the
  exception is documented in review

Promote to `business` when the component is a reusable business display unit:

- it represents a cross-surface Tutti concept such as workspace, file, task,
  agent, run, project, or account display state
- it receives all business data, labels, statuses, permissions, and callbacks
  from the host through props
- it receives user-visible copy through props, labels, or children instead of
  introducing new hardcoded product strings inside the shared component body
- it composes `base` components for buttons, fields, dialogs, cards, icons, and
  overlays instead of rebuilding those primitives locally
- it can be rendered in storyboard with controlled sample data and no daemon,
  router, store, or host adapter

Business promotion uses a copy-first workflow. Move the existing application
component structure into `@tutti-os/ui-system` as intact as possible, preserve
the source DOM hierarchy, visual states, and interaction layout, then remove
host-owned dependencies and standardize the API incrementally. Do not start by
inventing a cleaner abstraction or new visual treatment. Storyboard should first
prove source/screenshot parity; only then should props be generalized into
stable data, labels, actions, variants, and slots.

Promotion is not a redesign. The promoted UI must preserve the original design
unless the user explicitly approves a visual change. Do not add decoration,
layout chrome, controls, icons, copy, motion, states, spacing, or hierarchy that
cannot be traced to the source component or source screenshot. UI-system tokens
and primitives should replace local styling only when they keep the same
observed design and interaction path.

Copy-first promotion includes the candidate's dependent display subcomponents
and third-party-library wrappers. Pure presentational helpers should migrate
with the business component. Reusable wrappers around Radix, floating UI,
resizable panels, drag/drop, virtualization, editor shells, or similar libraries
should become or reuse `base` primitives before the business component composes
them. Host-coupled children must be split into caller-owned data, labels,
callbacks, or slots rather than rewritten from memory inside the promoted
component.

Do not promote a component when it owns:

- daemon, Electron, filesystem, router, or host-adapter calls
- data fetching, cache mutation, persistence, or polling
- global app store ownership
- workspace registration, navigation, onboarding, or other app workflow
  orchestration
- product copy that cannot be supplied by props or children

For every promoted component, define this contract before editing code:

- component `id` and `layer`
- source usage being replaced
- intended reuse surfaces
- public props and callbacks
- host-owned state and side effects that remain outside the component
- stable export path
- metadata entry
- storyboard states and examples
- validation commands

The bundled `packages/ui/system/agent/tutti-ui-system/SKILL.md` skill is the
standard prompt-level workflow for this judgment-heavy promotion step. Boundary
scripts are still required, but they only catch mechanical violations.

## API Shape And Composition

The public API must be derived from the source state matrix and intended reuse
surfaces, not from every conditional branch in the original component.

- Avoid boolean prop proliferation for rendering modes. Standard UI booleans
  such as `disabled`, `loading`, `selected`, `open`, `required`, or `invalid`
  are acceptable when they represent real state. Mode switches such as `isFoo`,
  `showBar`, and `withBaz` should usually become a finite variant,
  discriminated union, explicit component variant, slot, or composed child.
- Use explicit variants when combinations would otherwise create impossible
  states. Prefer a narrow discriminated union or named component variant over a
  component that accepts unrelated mode booleans.
- Prefer `children` and named slots for caller-owned visual regions. Use render
  props only when the shared component must pass data back to the caller.
- User-visible copy must stay caller-owned by default. Do not add hardcoded
  product strings inside `@tutti-os/ui-system` components when the text can be
  supplied by `labels`, `title`, `description`, `children`, or other explicit
  props. If a legacy-compatible fallback string must exist temporarily, treat it
  as compatibility debt rather than the preferred API pattern.
- Use compound components and context only when the component is complex enough
  that consumers need to assemble subparts while sharing state. Do not add a
  provider for a simple card, row, badge, or button wrapper.
- If shared state is necessary, make the context contract narrow and
  injectable: `state`, `actions`, and `meta`. State implementation remains
  outside the visual subcomponents, and host-owned daemon, Electron, router,
  store, query, persistence, filesystem, or workflow behavior remains outside
  the UI-system package.
- For new components, follow the repository's React 19 baseline, including
  `ref` as a prop where a ref is part of the public contract. Do not rewrite
  shadcn or Radix-acquired components only to chase API style parity.

Document the API shape decision before promotion: which state axes became
variants, props, slots, children, compound subcomponents, provider state, or
host-owned caller logic.

## Token Rules

- CSS variables are the source of truth for theme values
- Shared theme styles must support both host-managed
  `html[data-theme="light" | "dark"]` and workspace-app CSS
  `prefers-color-scheme`; explicit `data-theme` values should override system
  preference when both are present.
- Tailwind utilities should consume the same token layer rather than defining a parallel color system
- prefer semantic token names such as `background`, `foreground`, `primary`, `muted`, and `destructive` over raw palette leakage in public APIs
- keep tutti-specific token extensions additive and minimal
- Build primitives for a calm workbench shell, not for marketing-card
  theatrics.

For cross-surface stacking, use shared semantic `z-index` tokens instead of
local magic numbers. Current global layer tokens live in
`packages/ui/system/src/styles/theme.css` and should be the default source of
truth for:

- workbench chrome overlays
- popovers and menus
- toasts
- full-panel overlays
- dialogs and their backdrops

When a surface needs a new global layer, add a responsibility-named token to the
shared theme rather than introducing another raw `z-[12345]` value in app code.
Small component-internal stacking such as `z-1` on a pseudo-element can stay
local when it does not participate in global overlay ordering.

### Z-Index Design Rules

Treat `z-index` as an ordering system, not as a per-component escape hatch.

Use these rules:

- use shared global tokens when a layer can overlap content owned by another component, feature, portal, or renderer surface
- use package-local or component-local variables when the layer only needs to order parts inside one isolated surface
- keep local decorative layering simple; values such as `0`, `1`, `2`, or `3` are acceptable when they never compete with global overlays
- do not introduce new raw high values such as `9999`, `10000`, or `z-[12345]` in app code
- prefer a new responsibility-named token over “one bigger number” when an existing global layer is not sufficient

Questions to ask before adding or changing a layer:

1. Can this element ever overlap a portal, popover, toast, dialog, or another feature-owned overlay?
2. Is this a global interaction layer or only internal ordering inside one component?
3. Would another engineer understand the layer’s purpose from its token name alone?

If the answer to the first question is yes, the layer should almost always use a
shared global token.

### Current Global Layers

The current shared global `z-index` tokens are:

- `--z-workbench-chrome`
  Top or bottom workbench chrome rendered above window content but below global popovers and dialogs.
- `--z-workbench-genie`
  The genie animation layer that must stay above ordinary workbench chrome.
- `--z-popover`
  Cross-feature floating UI such as menus, switchers, and layout popovers.
- `--z-toast`
  Toast notifications that should stay above popovers.
- `--z-panel`
  Full-panel overlays such as workspace settings surfaces.
- `--z-panel-popover`
  Popovers or menus that are portaled from within a full-panel overlay and must stay above the panel but below dialog backdrops.
- `--z-dialog-overlay`
  Dialog backdrops that should dim or block panel surfaces beneath them.
- `--z-dialog`
  Dialog content rendered above dialog backdrops.
- `--z-dialog-popover`
  Floating controls or host-owned preview windows that must stay above dialog content and backdrop while remaining below tooltips.
- `--z-tooltip`
  Short hover/focus guidance that should stay above panels, drawers, and their popovers so clipped text can be inspected across overlay boundaries.

These tokens are intentionally semantic and ordered by responsibility, not by
visual implementation detail.

### Local Layering Rules

Local layers should stay local when they only solve ordering inside one bounded
surface. Good examples:

- a selected tile border inside one settings grid
- a resize handle above adjacent pane content inside one file manager surface
- a tooltip above its own dock icon inside one workbench dock
- background decorations behind launcher content

For these cases:

- prefer package-local variables such as `--workbench-z-dock-tooltip` or `--workspace-file-manager-dialog-overlay-z-index`
- keep the numeric scale tight and relative to the owning surface
- do not promote a local layer into the global theme unless another surface needs to reason about it

### Migration Rules

When touching existing code:

- replace raw high `z-index` values with the nearest existing semantic token when the layer is globally meaningful
- if no existing token matches, add a new one in `packages/ui/system/src/styles/theme.css` and document it here
- if the layer is local-only, prefer a package or component variable instead of a new global token
- remove transitional duplicate declarations such as a Tailwind `z-*` class plus an overriding inline `style.zIndex`

## Reusable Package Styling Rules

Reusable packages outside `packages/ui/*` should not create their own visual
systems. They should consume `@tutti-os/ui-system` primitives, icons, tokens, and
token-backed Tailwind utilities as their default styling model.

For reusable packages that render Tailwind utility classes, consumers are
responsible for including the published package output in Tailwind source
scanning. For example, a consumer of `@tutti-os/workbench-surface` should include
that package's built output in its Tailwind entrypoint or equivalent build
configuration:

```css
@source "../node_modules/@tutti-os/workbench-surface/dist";
```

Within this monorepo, reusable packages that require consumer Tailwind scanning
should declare that requirement in their `package.json`:

```json
{
  "tutti": {
    "tailwindSourceRoot": "src"
  }
}
```

`pnpm check:ui-boundaries` validates that the desktop renderer entrypoint
`apps/desktop/src/renderer/src/style.css` includes matching `@source` directives
for any imported workspace package that declares `tutti.tailwindSourceRoot`.
It also validates that the path matches the declared source root and reports the
exact `@source` line to add or replace.

Tailwind source troubleshooting checklist:

- if a reusable package introduces new utility classes but the desktop UI does not change at runtime, confirm the package declares `tutti.tailwindSourceRoot` when it renders runtime Tailwind classes
- confirm the desktop renderer Tailwind entrypoint includes the package source path through `@source`
- re-run `pnpm check:ui-boundaries` before assuming the issue is a hot-reload or build-cache problem

Package-local CSS in reusable packages is an exception, not the default. Add it
only when the package needs selectors, keyframes, or structural behavior that is
awkward to express through UI system primitives and Tailwind utilities.

When package-local CSS is necessary:

- use UI system CSS variables or Tailwind-facing semantic tokens
- keep the CSS structural and package-responsibility-specific
- do not define raw palette values, a second token layer, or app-specific visual roles
- do not include product styling, product copy, or app-specific state concepts
- document the public stylesheet entrypoint in the package README and package release docs

If a reusable package repeatedly needs visual primitives or new semantic tokens,
prefer moving that foundation into `@tutti-os/ui-system` before adding more
package-local CSS.

## Design Foundation Compliance

All components promoted into `@tutti-os/ui-system` must fully follow the
existing design foundations owned by this package. Promotion must align with the
shared token model, theme variables, spacing rhythm, radius scale, typography,
surface language, focus states, disabled states, and the existing `base`
primitive vocabulary.

Do not introduce a second visual language during promotion. Avoid raw palette
values, ad hoc spacing scales, local radius conventions, duplicate button or
field treatments, or component-specific CSS that should be expressed through
existing tokens or primitives.

Current shared control contracts:

- routine `Button` and `Input` surfaces use `32px` height, the shared `6px`
  `--radius-md`, token-backed text and surface colors, and no decorative
  shadows
- chrome icon buttons stay compact, transparent by default, and use the shared
  chrome text/hover states rather than app-local canvas colors
- text fields use `--transparency-block` for the default surface and
  `--transparency-hover` for hover/focus surfaces
- destructive controls use semantic danger tokens such as `--state-danger` and
  `--state-danger-hover`
- `UnderlineTabs` labels and counts use `font-medium`, so English contexts
  render at `font-weight: 500`; CJK contexts remain aligned through the global
  CJK emphasis rule

After a component is promoted, start an independent design-foundation review
subagent before reporting completion. Give the subagent the promoted component
files, source usage, selected states, storyboard entry, metadata entry, and this
document. The subagent should verify that the component follows the design
foundation and report any drift. If a subagent cannot be started in the current
environment, report the verification as blocked instead of claiming full
design-foundation compliance.

## Component Rules

- `base` primitives should stay low-level and presentation-focused
- `business` components may include reusable business display semantics, but
  must stay host-agnostic and side-effect-free
- `packages/ui/system` is the repository's shared Radix and shadcn host package
- for primitives that exist in the shadcn registry, start from shadcn CLI output targeted at `packages/ui/system`; do not hand-author a fresh component body when the upstream primitive can be downloaded
- keep `packages/ui/system/components.json` healthy enough that `pnpm dlx shadcn@latest add <component> -c packages/ui/system` remains the default acquisition path
- treat CLI-generated source as the canonical starting point; repository-specific edits should stay narrow and mechanical, such as package import aliases, stable barrel exports, icon-layer routing, and token-backed class adjustments required by boundary checks
- if a desired primitive is not available from shadcn, prefer composing directly from `radix-ui` inside `packages/ui/system` and document that exception in the change review or follow-up docs
- if the current package structure makes CLI acquisition awkward, fix the host package structure or configuration first instead of silently replacing the workflow with a handwritten primitive
- keep primitive APIs close to upstream shadcn patterns unless product-specific constraints require a deviation
- do not place app-specific workflows such as launcher flows, workspace
  registration, or route-owned panels in the shared package
- do not add new hardcoded user-visible copy inside `@tutti-os/ui-system`
  components when the text can be supplied by props, `labels`, `title`,
  `description`, or `children`; keep translation lookup and copy selection in
  the caller
- export UI-system components through stable package barrels instead of exposing
  per-file component paths
- only move a component into `@tutti-os/ui-system` when it is a real
  visual-system primitive or reusable business display component with more than
  one plausible consumer
- every public component, icon, utility, style entry, or tooling-visible UI
  export must have metadata in
  `packages/ui/system/src/metadata/components.json`
- metadata `source` paths must point at existing files under `packages/ui/system/src`
  and `from` must use a stable public entrypoint
- run `node tools/scripts/check-ui-metadata.mjs` or
  `pnpm check:ui-boundaries` after adding, removing, or renaming UI-system
  public exports

### Primitive Sourcing Workflow

Use this workflow when adding or replacing a shared primitive:

1. Run shadcn CLI against `packages/ui/system` when the primitive exists in the registry.
2. Keep the downloaded component body as the baseline implementation.
3. Apply only the minimum package-specific adaptation required to satisfy repository rules.
4. Export the primitive through the stable `@tutti-os/ui-system` barrels.
5. Re-run `pnpm check:ui-boundaries` after the adaptation pass.

Repository-specific adaptation is allowed for:

- replacing direct third-party icon imports with `@tutti-os/ui-system` icon exports when the UI boundary check requires it
- switching import aliases to package-local `#components`, `#icons`, or `#lib` paths
- aligning classes with shared CSS tokens or other repository-owned boundary rules

Repository-specific adaptation is not a reason to skip CLI acquisition. The rule of thumb is:

- download first
- adapt second
- do not handwrite the primitive body from scratch unless there is no upstream shadcn primitive to start from

### Business Component Workflow

Use this workflow when promoting reusable business UI:

1. Read existing `@tutti-os/ui-system/metadata` and storyboard entries first.
2. Reuse existing `base` and `business` components when they cover the need.
3. Keep host state, side effects, data loading, routing, and daemon calls in the
   original app or package.
4. Extract only the reusable display surface and typed callback contract.
5. Compose `base` primitives for controls, overlays, cards, icons, and layout
   affordances.
6. Add metadata with `layer: "business"` and a readable stable `id`.
7. Add storyboard examples that cover empty, loading, normal, disabled, and
   error-like display states when those states are part of the public contract.
8. Replace the original duplicated UI with a stable public import from
   `@tutti-os/ui-system`.

Business components should look like controlled React components:

```tsx
<WorkspaceSummaryCard
  workspace={workspace}
  status={workspaceStatus}
  disabled={!canOpenWorkspace}
  onOpen={handleOpenWorkspace}
/>
```

They should not reach back into the host:

```tsx
useWorkspaceStore();
useNavigate();
invokeDaemon();
fetch("/api/workspaces");
localStorage.setItem("workspace", id);
```

## Promotion Review Gate

Use this gate for every base or business component promotion. It adapts
frontend design review practice to Tutti's product standard; do not import
general marketing, portfolio, or decorative frontend heuristics into the shared
workbench system.

### Frictionless

- The migrated consumer preserves the original task path and interaction count
  unless the user approved a behavior change.
- Primary, secondary, destructive, cancel, and recovery actions keep their
  visual hierarchy and remain reachable by keyboard.
- The shared component does not introduce dead ends, hidden required steps, or
  new caller-owned state requirements.

### Quality Craft

- Selected states have before/after visual parity evidence from the source
  route, storyboard, or smallest reproducible view.
- The implementation uses existing `@tutti-os/ui-system` primitives and
  canonical tokens before adding component-local CSS.
- Light, dark, focus-visible, hover, disabled, invalid, selected, loading, and
  reduced-motion states are covered when they exist in the public contract.
- Layout, density, spacing, radius, typography, icon sizing, border, color,
  opacity, shadow, and responsive behavior have no unapproved drift.
- Any intentional delta is named, justified, and reported as approved rather
  than hidden inside the promotion.

### Trustworthy

- Loading, empty, disabled, error-like, and permission-limited states keep clear
  labels and actionable recovery where the source had them.
- AI-generated or inferred content keeps provenance, confidence, or disclaimer
  treatment host-owned and visible when applicable.
- Error copy and status labels are supplied by the caller or labels props; the
  shared component must not invent product policy or workflow meaning.
- New user-visible copy should enter the component boundary through props,
  labels, or children rather than new hardcoded strings inside the shared
  component.
- The component boundary leaves daemon, Electron, router, persistence, query,
  filesystem, polling, i18n lookup, and workflow orchestration in the host.

Report the promotion review in this structure:

- context: component id/layer, source usage, user task, selected states, and
  intended reuse surfaces
- summary: pass, needs work, or blocked
- pillar assessment: Frictionless, Quality craft, Trustworthy
- design-system compliance: tokens, primitives, metadata, storyboard, stable
  exports, and public imports
- issues: blocking, major, and minor, with concrete file references
- validation: exact commands and results
- risks: uncovered states, unavailable visual evidence, unresolved subagent
  review, or approved visual deltas.

## Agent Skill Rules

Use the bundled `tutti-ui-system` skill for prompt-level work involving
`@tutti-os/ui-system`. The source lives under
`packages/ui/system/agent/tutti-ui-system/SKILL.md` so it can ship with the UI
system package.

The skill should route internally across these scenarios:

- use an existing UI-system component
- extract a new `base` component
- extract a new `business` component
- maintain metadata, ids, exports, or storyboard coverage

The skill must treat this document, `packages/ui/AGENTS.md`, metadata, and
boundary scripts as the source of truth. It should not duplicate long copies of
the rules; it should point the coding agent to the right files, force the
base/business decision, and require validation.

External business repositories that promote UI into the shared system should add
a short agent instruction such as:

```md
When promoting business UI into @tutti-os/ui-system, use the
tutti-ui-system skill and follow packages/ui/system/ui-system.md.
```

After installing `@tutti-os/ui-system`, external repositories can configure the
bundled skill with:

```bash
pnpm exec tutti-ui-system-install-skill
```

The command copies the bundled skill into `.codex/skills/tutti-ui-system` in
the current repository. When `.tutti-ui-system-dev/` is present, the installer
prefers the synced source checkout so the skill and bundled UI-system rules stay
aligned with the current local UI-system source. It refuses to overwrite local
changes unless run with `--force`.

## Storyboard Rules

`apps/ui-storyboard` is the local component inventory and example surface for
`@tutti-os/ui-system`.

- the component list, categories, statuses, and inventory counts must come from
  `@tutti-os/ui-system/metadata`
- storyboard navigation should group component stories by `layer`
- examples may stay hand-written so they can show realistic composition and
  edge states
- visible component stories should display the component `id` prominently and
  support copying it from the UI
- the storyboard should import public UI-system entrypoints and metadata, not
  private component file paths
- keep the storyboard as a development surface; it should not become a product
  shell or marketing page

## External Dev Server Rules

The UI-system dev server exists only for local external development. It lets an
external app keep normal `@tutti-os/ui-system` imports while temporarily resolving
the stable entrypoints to a generated local cache.

- start it with `pnpm --filter @tutti-os/ui-system dev:server`
- external Vite apps opt in with `tuttiUISystemDev` from
  `@tutti-os/ui-system/dev-vite`
- when the server is unavailable, external apps must fall back to their
  installed package in `node_modules`
- the generated `.tutti-ui-system-dev/` cache belongs in the external app's
  `.gitignore`
- Tailwind consumers must include both the installed package output and the
  generated dev cache in source scanning, for example
  `@source "../node_modules/@tutti-os/ui-system/dist";` and
  `@source "../.tutti-ui-system-dev";`
- do not make CI, production builds, or package publishing depend on the dev
  server
- `@tutti-os/ui-system/dev-vite` may be imported only from bundler config or
  tooling files

## Icon Rules

- renderer-visible icons should be exported through the root package or the stable `@tutti-os/ui-system/icons` barrel
- promoted components and storyboard examples must consume icons from
  `@tutti-os/ui-system/icons`; do not leave inline SVG/data URI icons,
  app-local icon assets, or direct third-party icon imports in promoted UI
- generic system icons may wrap a third-party icon set
- product marks and custom status glyphs should live as local SVG components in the package
- icons should default to `currentColor` unless a specific token-driven treatment is required

## Review Heuristics

When reviewing a change under `packages/ui/*`, prefer these checks:

- is the new export responsibility-named and stable enough to support for a while
- could a consumer do the same work through the root package instead of a new subpath
- is a proposed helper really part of primitive support, or should it stay local to one app
- does the change make the package easier to consume without exposing its folder layout

## Review Questions

When reviewing a change under `packages/ui/*`, ask:

1. Is this a visual-system concern or an app-specific component?
2. Does this change preserve CSS tokens as the source of truth?
3. Is the package API still narrow, stable, and responsibility-named?
4. Would this be clearer if it stayed local to one app instead?
5. Are consumers being nudged toward the root package and stable barrels instead of internal paths?
