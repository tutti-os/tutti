# AGENTS.md

## Scope

This package owns shared Connector frontend behavior through three public
subpaths: `/application`, `/ui`, and `/i18n`. It intentionally exposes no root
barrel.

## Application

`src/application` owns host-neutral ports, lifecycle, state, view projection,
and semantic intents. Keep it React-, DOM-, Electron-, Desktop-, and
AgentGUI-free. Hosts inject transport, event, admission, and navigation ports.

## UI

`src/ui` is the only Connector-specific React owner. Use public
`@tutti-os/ui-system` components, icons, utilities, and semantic tokens. Keep
default Connector copy in the package i18n runtime; hosts merge or override it.
UI accepts Connector-owned neutral models and semantic callbacks. It imports no
Agent draft type, AgentGUI store, Desktop global, or generated daemon client.

AgentGUI retains draft/prompt/controller semantics and projects them into
neutral Renderer props. Desktop retains generated-client, account, workspace,
and product-navigation adapters.

Run this package's tests and typecheck for Renderer changes, plus
`pnpm check:connector-boundaries`, `pnpm check:ui-boundaries`, and
`pnpm check:i18n` when their surfaces change. Final validation follows the root
validation-selection policy.
