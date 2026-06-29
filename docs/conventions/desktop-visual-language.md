# Desktop Visual Language

This document defines the intended visual language for `tutti` desktop renderer surfaces.

It captures durable design rules for a disciplined desktop workbench language,
adapted to `tutti`'s lighter current product shell.

## Purpose

`tutti` should not feel like a marketing site stitched together from pretty cards.

It should feel like:

- a welcoming desktop launcher at entry
- a disciplined workbench once the user is inside a workspace
- one coherent product shell across both states

This document exists to guide design and component decisions that scripts cannot judge.

## Source And Translation

The goal is not to mirror a different product's brand palette or asset style.

What should be carried over is the design discipline:

- token-first visual systems
- restrained depth and structural layering
- workbench-grade information hierarchy
- components that read as tools, not marketing tiles

What should not be copied directly:

- a brand-specific dark palette
- another product's naming or token vocabulary
- heavy adaptation of a deep-dark shell into places where `tutti` should stay lighter and calmer

## Core Posture

The desired `tutti` posture is:

- `launcher`: light, breathable, welcoming, slightly editorial
- `workspace`: sober, structured, workbench-like
- shared primitives: neutral, disciplined, reusable, not brand-performative

In short:

- the launcher may invite
- the workspace must support work

## Visual Hierarchy

Prefer hierarchy built from structure, not decoration.

Use these levers first:

- spacing rhythm
- container boundaries
- typography contrast
- subtle surface shifts
- restrained border and ring changes

Use these levers sparingly:

- large shadows
- saturated fills
- oversized icons
- decorative gradients
- high-motion emphasis

If multiple elements on a screen are all trying to feel "featured", the hierarchy is wrong.

## Color Strategy

`tutti` should remain light-first for now, but it should keep strong
discipline around color roles.

Guidelines:

- keep large surfaces quiet and low-noise
- reserve high-chroma color for focus, state, and a small number of primary actions
- keep semantic states stronger than decorative accents
- make status color useful before making it expressive

The UI system should optimize for semantic colors such as:

- background and elevated surfaces
- foreground and muted text
- border and input
- primary action
- accent
- success, warning, destructive

Brand color should not become a substitute for hierarchy.

## Typography Strategy

Typography should feel closer to a tool than a campaign page.

Guidelines:

- use one clear UI workhorse family for most interface text
- reserve display treatment for a small number of page titles or empty-state moments
- favor medium weight and clean rhythm over dramatic size jumps
- keep body copy easy to scan under medium information density

The overall hierarchy should compress gracefully:

- launcher can afford a more expressive page title
- workspace should favor clarity, compactness, and stable scanning patterns

## Radius And Depth

Prefer restrained workbench geometry.

Guidelines:

- default toward tool-like radii, not oversized marketing pills
- let radius scale communicate component class rather than visual novelty
- prefer fine borders and soft elevation over heavy drop shadows
- use glow or blur only when it clarifies layering, not just to add polish

In practice this means:

- buttons and controls should feel precise
- panels and cards should feel calm and substantial
- badges and chips may be rounder, but should not define the whole product language

## Component Language

Shared primitives should read as product infrastructure.

### Buttons

- primary buttons should mark true forward actions, not every clickable item
- secondary and ghost actions should carry most of the routine UI
- button styling should emphasize state clarity over visual loudness

### Cards And Panels

- cards should behave as information containers, not visual showcases
- major containers should define structure, grouping, and action placement
- inset sections should provide one level of nesting without creating a second visual theme

### Badges And Status

- badges should separate identity, state, and metadata roles
- status treatments should feel systematic and repeatable
- avoid decorative badge proliferation

### Icons

- icons should be semantic helpers first
- default icon usage should stay small and integrated with text or state
- oversized or high-contrast icons should be reserved for empty states, brand anchors, or rare hero moments

### Workbench Window Chrome

Workbench window headers should share one compact chrome language across Agent
GUI, task center, file manager, and future workspace tools.

Use these rules:

- use `--background-panel` for the header surface unless a host shell owns a
  more specific chrome token
- keep window titles at `15px`, semibold, `20px` line height, and
  `--text-primary`
- keep routine chrome icons at `14px`; reserve larger icons for content
  regions, empty states, or app identity
- keep macOS workspace traffic lights at the native `12px` diameter, `16px`
  leading inset, and vertically centered in the `52px` workspace header; custom
  Agent GUI workbench traffic lights should use the same `12px` size and `16px`
  leading inset, with `12px` between the traffic-light group and agent identity;
  custom workbench traffic lights should keep a `12px` visual dot inside a
  `20px` pointer hit area, and browser, file, task-center, Agent GUI, and future
  workbench node headers should place close/minimize/maximize controls on the
  leading side before titles or tool controls; update Electron
  `trafficLightPosition`, renderer header clearance, and custom workbench header
  spacing together
- keep Agent GUI workbench identity icons at `20px` square without shadows
- pin the Agent GUI conversation rail toggle to the trailing edge of the rail
  header area, without drawing a right border on the rail
- keep Agent GUI rail toolbar controls flush with the rail header; do not add
  extra top padding above the search field and new-session button
- use `--text-secondary` for inactive icon actions and `--text-primary` for
  hover/focus states
- place routine header actions with `4px` gaps and prevent pointer or double
  click events on those actions from starting window drags
- keep drag handles structural and invisible; do not create a second visible
  titlebar treatment inside individual tools

Window chrome should feel like a shared product shell, not like each workspace
module designed its own toolbar.

### Shared Control Defaults

Default workbench controls should be precise and quiet.

Use these rules:

- routine buttons and text inputs default to `32px` height and `6px` radius
- small icon buttons may use tighter radii, but should still inherit the shared
  radius scale instead of one-off values
- transparent field surfaces use `--transparency-block`, with
  `--transparency-hover` for hover and focus surfaces
- destructive buttons use `--state-danger`, `--state-danger-hover`, and
  `--white-stationary` instead of raw red fills
- underline tabs use `13px` labels and medium weight; in English contexts this
  means `font-weight: 500`, while CJK contexts keep the same 500 emphasis
  through the shared language rules

## Page Composition

Screens should follow a stable composition order:

1. establish the shell
2. place the working content
3. add emphasis only where needed

### Launcher

The launcher may use:

- more generous spacing
- stronger welcome copy
- slightly warmer or softer presentation
- clearer onboarding-style calls to action

### Workspace

The workspace should use:

- tighter but still readable spacing
- clearer module boundaries
- lower decoration density
- stronger alignment discipline across headers, metadata, controls, and status areas

Workspace surfaces should be ready to grow in complexity without changing visual dialect every time a new module appears.

### Settings Dialogs

Workspace settings dialogs are compact workbench overlays, not full pages.

Use these rules:

- center the dialog over a light blurred overlay
- use `--background-panel` for the settings dialog shell and sidebar; reserve `--background-fronted` for frontmost menus and select popovers
- use the shared `--backdrop` token for the settings overlay instead of raw overlay colors
- use `--shadow-elevated` for settings panel elevation and keep the shadow balanced around the panel; avoid large positive y-axis offsets that make the bottom edge look heavier than the shell
- use a `760px` desktop width cap, `500px` height cap, `16px` outer radius, and a `54px` title bar
- use a fixed two-column structure on desktop: `160px` section navigation on the left, settings content on the right
- keep navigation items compact and scannable, with selected state from the shared accent surface
- align compact setting rows as label/content pairs; labels use semibold `13px`, values use `11px`
- keep routine select/input controls around `200px` wide on desktop and full-width only on narrow responsive layouts
- keep routine controls at `32px` height with `6px` radius
- use token-backed danger surfaces for destructive zones: `--state-danger`, `--on-danger`, and `--on-danger-hover`
- portal popovers from inside the settings dialog above the panel with `--z-panel-popover`

The settings surface should look like a focused tool sheet. Avoid card stacks,
large decorative shadows, or one-off control styles inside individual sections.

## Anti-Patterns

Avoid these decisions even if they look attractive in isolation:

- turning every card into a featured tile
- using brand color as the main source of structure
- relying on oversized shadows to separate layout regions
- giving workbench surfaces marketing-style pill CTAs by default
- mixing airy launcher spacing into dense workspace surfaces without reason
- introducing one-off visual moods for individual modules inside the same workspace shell

## Design Review Questions

When reviewing renderer or `ui-system` work, ask:

1. Does this feel more like a tool shell or like a marketing fragment?
2. Is hierarchy coming from structure first, not color and effects first?
3. Is this component calm enough to survive repeated use across the product?
4. Does the launcher stay welcoming while the workspace stays work-oriented?
5. If this module grew denser, would the visual system still hold together?
