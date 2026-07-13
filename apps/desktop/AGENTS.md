# AGENTS.md

## Scope

This file applies to `apps/desktop/*`.

`apps/desktop` owns:

- Electron main-process lifecycle
- preload bridge and IPC exposure
- renderer UI
- native desktop integration
- starting, monitoring, and reconnecting to `tuttid`

`apps/desktop` must not become a second business core.

## Setup commands

- Start desktop development: `pnpm --filter @tutti-os/desktop dev`
- Build desktop: `pnpm --filter @tutti-os/desktop build`
- Typecheck desktop: `pnpm --filter @tutti-os/desktop typecheck`

## Directory guide

- `src/main/*`: Electron main-process code, including transport, host access, IPC, update, logging, and window creation
  Current composition is layered through `bootstrap.ts`, `desktopAppServices.ts`, `desktopDaemonRuntime.ts`, `desktopHostServices.ts`, and `desktopAppLifecycle.ts`.
- `src/preload/*`: safe bridge surface exposed to the renderer
- `src/renderer/src/app/windows/*`: renderer window composition shells
- `src/renderer/src/features/*`: reusable renderer feature modules; `services/internal/**` stays private to the owning feature
- `src/shared/*`: desktop-local contracts, shared error helpers, and i18n resources shared across main, preload, and renderer

The authoritative desktop directory shape lives in [docs/conventions/desktop-layering.md](../../docs/conventions/desktop-layering.md). Keep this file focused on change-time rules and checks rather than repeating the full structure spec.

Current naming guidance:

- use `Workspace` or `workspaceWindow` for the legacy Workbench shell
- use `Agent`, `Fusion Dock`, and `Fusion tool` for their typed standalone
  renderer shells and native-window roles
- prefer the explicit `view=workspace`, `view=agent`, `view=fusion-dock`, and
  `view=fusion-tool` intents over vague names such as `main`

## Action rules

- keep business rules out of renderer, preload, and main-process code
- prefer calling `tuttid` or desktop IPC adapters instead of re-implementing workflows in Electron
- keep preload surfaces narrow and explicit
- keep webview guest preload entries self-contained at runtime. Avoid runtime imports from shared contracts or helpers in `src/preload/entries/browserNodeGuest.ts`, `src/preload/entries/workspaceApp.ts`, and directly imported guest-preload helpers unless the build output proves they are inlined. `import type` is fine.
- keep Electron-only concerns in `src/main/*` and renderer window composition under `src/renderer/src/app/windows/*`
- keep managed-daemon shutdown deterministic; when quit flow depends on daemon cleanup, gate app exit instead of firing cleanup in the background
- keep renderer feature logic in feature-local services; services assemble commands, adapters, request flow, and side effects
- treat `window.tutti` as a renderer window-composition input; feature UI and feature services must not read it directly
- render UI from state-library snapshots and selectors; React handles DOM events, subscriptions, and rendering rather than feature orchestration
- treat fewer `useEffect` calls as an architecture constraint; move feature data flow into services, stores, reducers, or selectors when possible
- do not import another feature's `services/internal/**`
- do not mutate feature stores outside their owning service
- route desktop-owned user-visible copy through `src/shared/i18n`; this includes renderer product text, Electron dialog labels, status copy, empty states, host-owned workbench text, and user-facing error messages
- keep reusable package default i18n resources with the owning package; the renderer app-level i18n runtime should merge package defaults with desktop-owned resources instead of copying package strings back into `src/shared/i18n`
- prefer consuming shared visuals from `@tutti-os/ui-system` instead of growing a second token or primitive layer in renderer
- use `@tutti-os/ui-system` components wherever practical for renderer React UI, especially components under `src/renderer/src/features/*/ui`
- load `@tutti-os/ui-system/styles.css` once from the renderer style entrypoint rather than per component
- keep launcher surfaces lighter and more welcoming, while workspace surfaces stay denser and more workbench-like

## Testing defaults

- Run `pnpm --filter @tutti-os/desktop typecheck`
- Run `pnpm --filter @tutti-os/desktop test` when changing lifecycle, host access, or update-access helpers
- Run `pnpm check:electron-runtime-boundaries` for Electron `main`/`preload` runtime import changes or shared package-import changes that can affect those execution paths
- Run `pnpm check:i18n` for renderer UI text, Electron dialog labels, empty states, status copy, or user-facing error messages
- Run `pnpm --filter @tutti-os/desktop build` for desktop-facing behavior changes
- For webview guest preload changes, verify the build succeeds with the self-contained guest preload guard and that guest preload output does not contain relative chunk requires such as `require("./ipc-*.cjs")`
- If a change affects `@tutti-os/ui-system` consumption or renderer import shape, also run `pnpm check:ui-boundaries`
- If a change affects renderer feature structure or imports, also run `pnpm check:renderer-boundaries`
- If a change affects daemon interaction, also run the relevant `services/tuttid` checks

## Related docs

- [docs/conventions/README.md](../../docs/conventions/README.md)
- [docs/conventions/desktop-layering.md](../../docs/conventions/desktop-layering.md)
- [docs/conventions/desktop-visual-language.md](../../docs/conventions/desktop-visual-language.md)
- [docs/architecture/desktop-transport.md](../../docs/architecture/desktop-transport.md)
- [docs/architecture/desktop-windows.md](../../docs/architecture/desktop-windows.md)
- [docs/conventions/logging.md](../../docs/conventions/logging.md)
- [docs/conventions/tuttid-layering.md](../../docs/conventions/tuttid-layering.md)
- [packages/ui/system/ui-system.md](../../packages/ui/system/ui-system.md)
