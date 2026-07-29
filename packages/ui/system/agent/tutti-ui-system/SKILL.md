---
name: tutti-ui-system
description: Use when working with @tutti-os/ui-system components, replacing local UI with shared components, querying component ids or metadata, promoting UI into shared base or business components, or maintaining UI-system storyboard inventory.
---

# Tutti UI System

Use this skill as the single entrypoint for `@tutti-os/ui-system` component
reuse, extraction, promotion, metadata, and storyboard work.

## Non-Negotiable Standard

Any UI promoted into `@tutti-os/ui-system` must fully follow the UI-system
design standard before it can be reported as complete.

Treat these as hard requirements, not cleanup suggestions:

- use UI-system semantic tokens and existing shared CSS variables; do not leave
  raw `hex`, `rgb(...)`, `rgba(...)`, ad hoc gradients, or app-local palette
  values in promoted components or their storyboard examples unless the source
  of truth already exposes them as approved tokens
- compose existing UI-system `base` primitives such as `Card`, `Button`,
  `Tooltip`, `Dialog`, and related vocabulary before creating custom panel,
  button, field, or overlay treatments
- use icon components from `@tutti-os/ui-system/icons` for promoted
  components and storyboard examples. Do not inline SVG/data URI assets, import
  app-local icon files, or pull third-party icon packages directly from promoted
  UI. If the source UI depends on an icon that is not in the UI system, promote
  the source-derived icon into `packages/ui/system/src/icons` with metadata
  first, then consume the UI-system icon export.
- make storyboard examples render the real component surface and states; do not
  rely on surrounding docs chrome to hide component-level visual drift or to
  fake the final panel/surface language
- when a consumer is migrated, its final rendered result must also follow the
  same UI-system visual standard; a temporary bridge may help wiring, but it is
  not acceptable as the final visual implementation if it keeps a second token
  system or divergent component styling

If these conditions are not met, report the promotion as incomplete or blocked,
not complete.

## Source Of Truth

Read these before editing:

1. nearest `AGENTS.md` for the target code
2. local `AGENTS.md` bundled with this skill
3. local `ui-system.md` bundled with this skill
4. component metadata from the first available source:
   - `GET http://127.0.0.1:4100/components`
   - `packages/ui/system/src/metadata/components.json`
   - `@tutti-os/ui-system/metadata` from the installed package

Use stable public imports only:

- `@tutti-os/ui-system`
- `@tutti-os/ui-system/components`
- `@tutti-os/ui-system/icons`
- `@tutti-os/ui-system/metadata`
- `@tutti-os/ui-system/styles.css`
- `@tutti-os/ui-system/utils`

Never deep import `@tutti-os/ui-system/src/*` or per-file component paths.

## Route The Task

Read only the reference file that matches the task.

- Using or querying existing components:
  `references/use-existing-component.md`
- Extracting a low-level base primitive:
  `references/extract-base-component.md`
- Promoting reusable business UI into a shared component:
  `references/promote-business-component.md`
- Maintaining ids, metadata, exports, or storyboard inventory:
  `references/maintain-inventory.md`

## Global Boundaries

Keep these outside `@tutti-os/ui-system` components:

- daemon, Electron, filesystem, router, or host adapter calls
- data fetching, cache mutation, persistence, polling, and global store
  ownership
- workflow orchestration such as onboarding, workspace registration, install or
  uninstall flows, confirmation dialogs, queueing, or navigation
- i18n key lookup and business-specific copy derivation unless supplied by
  props, children, or labels

For any promoted public component, add stable exports, metadata, and storyboard
coverage that match the chosen reference workflow.

For promoted base components, preview coverage is not satisfied by metadata
alone. DOM components need a real renderable example in `apps/ui-storyboard`.
React Native components need a real renderable example in the Mobile
development gallery because the DOM storyboard cannot render their final
surface. In both cases, the example must use the stable public entrypoint and
show the component's public states.

For business component promotion, use a copy-first workflow: move the existing
business component structure as intact as possible, preserve the real DOM,
visual hierarchy, state branches, and interaction layout, then progressively
remove host dependencies and standardize the public API. Do not begin by
inventing a cleaner abstraction or new visual treatment. The state matrix,
props boundary, and candidate source UI define what to copy, what to keep
caller-owned, and what to standardize after parity exists.

Treat business component promotion as an iterative migration-review loop, not a
single extraction pass:

1. migrate the source UI copy-first
2. recreate source-backed states in storyboard
3. run independent review against the original source and screenshot
4. migrate again to close review findings
5. repeat review until source/design parity is acceptable

Only after that loop should the API be generalized further. Do not report the
component as complete after the first migration if review still shows material
DOM, visual, token, state, icon, or storyboard coverage drift.

The promoted UI must follow the original design exactly unless the user
explicitly approves a visual change. Do not add new decoration, controls,
icons, layout chrome, copy, motion, states, spacing, or visual hierarchy that
does not exist in the source UI or provided screenshot. If UI-system token or
primitive replacement is needed, it must preserve the observed design and
interaction path rather than becoming a redesign.

Copy-first also applies to dependent presentational subcomponents and
third-party-library wrappers used by the candidate UI. Do not copy only the top
level JSX and recreate nested behavior from memory. Trace the dependency tree:
pure display helpers should move with the component; reusable wrappers around
Radix, floating UI, resizable panels, virtualization, or similar libraries
should be promoted or reused as `base` primitives first; host-coupled children
must be split into caller-owned data, labels, callbacks, or slots before the
business component is considered promoted.

## Design Foundation Verification

Every promoted component must comply with
`ui-system.md`, especially the shared tokens,
theme variables, spacing, radius, typography, surface language, interactive
states, and existing `base` primitive vocabulary.

Explicitly check and report all of these before completion:

- color and surface styling come from UI-system semantic tokens rather than raw
  palette values
- panels, rows, controls, and overlays compose existing base primitives where
  applicable instead of recreating them locally
- storyboard shows the component's real promoted surface rather than only a
  documentation wrapper
- migrated consumers no longer depend on a separate visual token system for the
  promoted surface

Run the Tutti promotion review gate before reporting completion. The gate is
adapted from frontend design review practice but constrained to Tutti's dense
workbench product language:

- Frictionless: the migrated consumer preserves the original task path, keeps a
  clear action hierarchy, and does not bury primary or recovery actions.
- Quality craft: visual parity evidence is captured for selected states, shared
  tokens and primitives are used, light/dark and interactive states work, and no
  unapproved raw palette, spacing, radius, typography, or motion drift remains.
- Trustworthy: empty, loading, disabled, error-like, permission-limited, and
  AI-generated-content states keep clear labels, actionable recovery, and
  host-owned policy or provenance outside the shared component.

After promoting a base or business component, start an independent subagent to
review design-foundation compliance before reporting completion. Provide the
subagent with the promoted files, source usage, selected states, storyboard and
metadata entries, and the UI-system guidelines. If subagents are unavailable,
state that design-foundation verification is blocked and do not claim full
compliance.

Report the gate result with:

- context: source usage, promoted component id/layer, user task, selected states
- status: pass, needs work, or blocked
- pillar assessment: Frictionless, Quality craft, Trustworthy
- issues grouped as blocking, major, and minor
- validation commands and exact results
- remaining risks, uncovered states, or approved visual deltas

## API Composition Review

When converting source states into public props, review the API shape before
writing the promoted component:

- avoid boolean prop proliferation for rendering modes; mode axes such as
  `isFoo`, `showBar`, or `withBaz` must come from code evidence and usually
  become a finite variant, discriminated union, explicit component variant,
  slot, or composed child
- keep standard UI booleans such as `disabled`, `loading`, `selected`, `open`,
  `required`, and `invalid` only when they represent real component state and
  cannot create impossible combinations
- prefer `children` or named slots for caller-owned visual regions; use render
  props only when the shared component must pass data back to the caller
- use compound components and context only for genuinely complex reusable
  structures where consumers need to compose subparts without prop drilling
- if shared state is needed, define a narrow context value as `state`,
  `actions`, and `meta`; providers may inject state but must not own daemon,
  Electron, router, store, query, persistence, or workflow side effects
- for new React components in this React 19 codebase, prefer the React 19 API
  shape such as `ref` as a prop; do not churn shadcn or Radix-acquired code only
  to normalize style when behavior and public API are already sound

Report the API composition decision with the state matrix: which differences
became props, variants, slots, children, explicit variants, provider state, or
stayed host-owned.

## Validation Commands

Run the smallest relevant checks from the selected reference. Common checks are:

```bash
node tools/scripts/check-ui-metadata.mjs
pnpm check:ui-boundaries
pnpm --filter @tutti-os/ui-storyboard typecheck
```

If runtime component code changed, also run the relevant package typecheck or
consumer build.

When a base component is promoted, verify both of these conditions before
reporting completion:

- the component metadata opts into storyboard visibility when appropriate
- `apps/ui-storyboard` contains a concrete rendered example for the promoted
  component states, not just inventory wiring
