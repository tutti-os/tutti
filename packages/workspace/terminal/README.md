# Workspace Terminal

Reusable terminal node contracts and shared frontend surface for Tutti
workspace hosts.

The package owns host-agnostic terminal semantics. Hosts own concrete process
launching, daemon clients, VM routing, Electron bridges, product copy, and
durable terminal storage.

See `docs/architecture/workspace-terminal.md` for the current architecture and
package boundary.

## Internal Layering

The shared terminal surface is intentionally split into narrow layers:

- `src/core/sessionController.ts`
  Owns terminal session orchestration. It composes recovery, state storage,
  input queueing, and transport lifetime, but should stay thin.
- `src/core/sessionControllerStore.ts`
  Owns in-memory terminal session state such as `rawOutput`, `inputReady`, and
  `surfaceError`.
- `src/core/sessionControllerRecovery.ts`
  Owns `snapshot -> attach -> replay` recovery semantics and transport event
  hydration.
- `src/core/sessionDiagnostics.ts`
  Owns diagnostic event shaping so core and react layers do not scatter event
  names and payload shapes.
- `src/react/terminalSurfaceRuntime.ts`
  Owns xterm wiring, buffered terminal writes, screen-cache restore/persist,
  resize observation, and host-agnostic terminal view behavior.
- `src/react/TerminalSurface.tsx`
  Owns composition only. It should bind hooks, runtime handles, and UI
  controls, but should not become the owner of terminal transport recovery.

## Guardrails

- React view remounts must not directly own `snapshot`, `attach`, or `detach`.
- Recovery behavior should be testable in `src/core/*` without mounting React.
- Terminal view sync behavior should be testable in small `src/react/*` helper
  tests without constructing full host adapters.
- New diagnostics should be added through `sessionDiagnostics.ts` instead of
  scattering raw event strings across the package.
- Host-specific bridges, preload APIs, daemon clients, and absolute-path
  policies stay outside this package.

## Maintenance Rule Of Thumb

When adding new behavior, prefer:

1. pure helper in `src/core` or `src/react`
2. narrow composition in `sessionController` or `terminalSurfaceRuntime`
3. minimal wiring in `TerminalSurface` or `TerminalNode`

If a change wants to put transport lifetime, recovery sequencing, or daemon
policy back into a React component, that is usually a sign the boundary is
slipping.
