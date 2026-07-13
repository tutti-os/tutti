# Browser Node Advanced Actions Implementation Plan

**Goal:** Add device emulation, full-page screenshots, Cookie import, and an in-product browser settings surface without moving browser policy into the desktop renderer.

**Architecture:** Keep reusable contracts, runtime state, Cookie parsing, and Electron guest operations in `@tutti-os/browser-workbench-node`. The desktop host owns native file/directory dialogs and IPC transport. The renderer only presents settings and invokes the package host API. Settings apply to the active browser session for the current app run; popup and external-navigation security policy remains fixed.

## Task 1: Extend package contracts and runtime state

- Add screenshot modes, device presets, Cookie import results, and browser session settings types.
- Add optional host API operations and runtime-store events.
- Cover state transitions with focused unit tests.

## Task 2: Implement Electron guest capabilities

- Capture full-page screenshots through the Chrome DevTools Protocol while preserving existing visible-area capture.
- Enable and disable fixed device-emulation presets.
- Parse JSON and Netscape Cookie exports, validate entries, and import only into the active guest session.
- Support choosing and applying a download directory.
- Add unit tests for parsers, page actions, and manager behavior.

## Task 3: Wire desktop IPC and native dialogs

- Extend shared IPC contracts, main-process registration, preload API, and preload types.
- Use native open/save dialogs for Cookie files, screenshot output, and download directories.
- Avoid exposing Cookie file contents to the renderer or diagnostics.

## Task 4: Build the browser settings experience

- Add device-emulation and screenshot-mode actions to the overflow menu.
- Add a UI System-based settings dialog for device preset, zoom, screenshot mode, download directory, Cookie import, and browsing-data clearing.
- Route all visible copy through BrowserNode i18n resources.

## Task 5: Document and verify

- Update package and architecture documentation for ownership and session-scoped behavior.
- Run focused package tests, desktop/package typechecks, i18n/UI boundary checks, desktop build, and changed-aware validation.
