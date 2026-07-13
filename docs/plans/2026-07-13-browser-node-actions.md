# Browser Node Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Add page find, printing, zoom controls, visible-page screenshots, download management, and profile-scoped browsing-data clearing to the Browser Node overflow menu.

**Architecture:** Extend the reusable `@tutti-os/browser-node` contract and Electron guest manager with generic browser actions and state events. Keep native file dialogs, download-folder integration, and file opening in the desktop host adapter. Reuse the existing UI System menu, buttons, inputs, and confirmation dialog, with all browser copy in the package i18n module.

**Tech Stack:** React 19, TypeScript, Electron 35, `@tutti-os/ui-system`, Node test runner.

---

### Task 1: Extend Browser Node contracts and runtime state

**Files:**

- Modify: `packages/browser/workbench-node/src/core/types.ts`
- Modify: `packages/browser/workbench-node/src/core/runtimeStore.ts`
- Test: `packages/browser/workbench-node/src/core/runtimeStore.test.ts`

**Steps:**

1. Add typed inputs for find, zoom, screenshot, browsing-data clearing, and download actions.
2. Add find-result and download-state Browser Node events.
3. Extend the runtime store with stable find, zoom, and download snapshots.
4. Add failing runtime-store tests for find and download event transitions.
5. Implement the minimal reducer changes and rerun the focused tests.

### Task 2: Implement Electron guest actions

**Files:**

- Modify: `packages/browser/workbench-node/src/electron-main/types.ts`
- Modify: `packages/browser/workbench-node/src/electron-main/guestManager.ts`
- Test: `packages/browser/workbench-node/src/electron-main/electronMain.test.ts`

**Steps:**

1. Extend the mockable guest interfaces with find, print, zoom, session clearing, and download APIs.
2. Add failing tests for find results, printing, zoom clamping, screenshot capture, data clearing, and download lifecycle/actions.
3. Implement action routing against the registered guest only.
4. Attach and detach `found-in-page` and session download listeners without leaking across guest lifecycles.
5. Rerun the focused package tests.

### Task 3: Wire package IPC and desktop-native adapters

**Files:**

- Modify: `packages/browser/workbench-node/src/electron-main/registerElectronMain.ts`
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`
- Modify: `apps/desktop/src/preload/api/browser.ts`
- Modify: `apps/desktop/src/main/ipc/browser.ts`
- Test: `packages/browser/workbench-node/src/electron-main/electronMain.test.ts`

**Steps:**

1. Add optional package IPC channels and handlers for each new action.
2. Add desktop IPC request and response mappings.
3. Expose the narrow preload API methods.
4. Save screenshots through a native save dialog and PNG write in the desktop host.
5. Configure browser sessions to use the operating-system Downloads directory.
6. Route open-file and reveal-in-folder download actions through Electron `shell`.
7. Add handler-routing tests and rerun them.

### Task 4: Build the Browser Node menu and panels

**Files:**

- Modify: `packages/browser/workbench-node/src/react/BrowserNode.tsx`
- Modify: `packages/browser/workbench-node/src/i18n/browserNodeI18n.ts`

**Steps:**

1. Make the overflow menu independent of the development-only DevTools action.
2. Add the find bar with query, result count, previous/next, and close behavior.
3. Add the inline zoom controls with reset, decrease, and increase actions.
4. Add print, screenshot, and downloads commands.
5. Add a compact downloads panel with progress, pause/resume, cancel, open, and reveal actions.
6. Add a UI System confirmation dialog before clearing the active browser profile's browsing data.
7. Route all English and Simplified Chinese copy through package i18n.

### Task 5: Verify boundaries, behavior, and documentation

**Files:**

- Modify: `docs/architecture/browser-node-package.md`
- Modify: `docs/conventions/troubleshooting/toolchain-browser-terminal.md` only if verification reveals a reusable debugging trap.

**Steps:**

1. Run `pnpm --filter @tutti-os/browser-node test`.
2. Run `pnpm --filter @tutti-os/browser-node typecheck`.
3. Run `pnpm --filter @tutti-os/desktop typecheck`.
4. Run `pnpm check:i18n` and `pnpm check:ui-boundaries`.
5. Run `pnpm --filter @tutti-os/desktop build`.
6. Inspect the final diff for package/host ownership, raw UI copy, and accidental unrelated changes.
7. Update the Browser Node architecture document with the new action and native-host ownership boundaries.
