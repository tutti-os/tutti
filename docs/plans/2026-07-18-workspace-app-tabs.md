# Workspace App Tabs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add browser-like multi-tab navigation to the workspace application window.

**Architecture:** Persist ordered app tabs in `WorkspaceAppCenterViewState`, route app launches into the singleton app-center node, and render all open inline app webviews beneath one tab strip. Keep host orchestration in desktop services and reusable view-state normalization in the workspace app-center package.

**Tech Stack:** React 19, TypeScript, Valtio, `@tutti-os/ui-system`, `@tutti-os/workbench-surface`, Node test runner.

---

### Task 1: Persist application tabs

**Files:**

- Modify: `packages/workspace/app-center/src/contracts/host.ts`
- Modify: `packages/workspace/app-center/src/core/appCenterControllerHelpers.ts`
- Test: `packages/workspace/app-center/src/core/appCenterController.test.ts`

**Steps:**

1. Add a failing test for normalized, deduplicated `openAppIds` and legacy
   `openAppId` restoration.
2. Run `pnpm --filter @tutti-os/workspace-app-center test` and confirm failure.
3. Add `openAppIds` to the view-state contract, normalization, and equality.
4. Rerun the package test and confirm it passes.

### Task 2: Define tab selection and close behavior

**Files:**

- Create: `apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterTabs.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterTabs.test.ts`

**Steps:**

1. Add failing tests for opening an existing/new app and closing active/inactive
   app tabs.
2. Run the targeted desktop test and confirm failure.
3. Implement pure tab-state helpers.
4. Rerun the targeted test and confirm it passes.

### Task 3: Route launches into the application window

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-workbench/services/workbenchWorkspaceAppSurfacePresenter.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-workbench/ui/useWorkspaceWorkbenchShellRuntime.tsx`
- Modify: `apps/desktop/src/renderer/src/features/workspace-workbench/services/standaloneAgentWorkspaceAppSurfacePresenter.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-workbench/services/workbenchWorkspaceAppSurfacePresenter.test.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-workbench/services/standaloneAgentWorkspaceAppSurfacePresenter.test.ts`

**Steps:**

1. Replace the presenter expectations with tests for tab state, singleton
   app-center launch/focus, close, and rollback.
2. Run the targeted tests and confirm failure.
3. Update both presenters to use the shared tab-state helpers.
4. Register the normal presenter with app-center view-state access.
5. Rerun the targeted tests and confirm they pass.

### Task 4: Render browser-like app tabs

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterContribution.tsx`
- Modify: `apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterInlineAppBody.tsx`
- Modify: `apps/desktop/src/shared/i18n/locales/en.ts`
- Modify: `apps/desktop/src/shared/i18n/locales/zh-CN.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterInlineAppRetention.test.ts`

**Steps:**

1. Add failing source/behavior tests for the fixed catalog tab, application
   tabs, close buttons, and add action.
2. Run the targeted desktop test and confirm failure.
3. Replace the back button header with the tab strip using UI System primitives
   and semantic tokens.
4. Render inline app bodies from persisted open tabs and unmount closed tabs.
5. Add localized accessibility labels and rerun the tests.

### Task 5: Verify and update the running desktop

**Files:**

- Review: `docs/conventions/desktop-visual-language.md`
- Review: `docs/conventions/troubleshooting/README.md`

**Steps:**

1. Run `pnpm --filter @tutti-os/workspace-app-center test`.
2. Run targeted desktop tests for the changed presenters and app-center UI.
3. Run `pnpm check:i18n`, `pnpm check:ui-boundaries`, and
   `pnpm check:renderer-boundaries`.
4. Run `pnpm lint:ts`, `pnpm typecheck`, and
   `pnpm --filter @tutti-os/desktop build`.
5. Check the final diff for durable documentation impact.
6. Trigger exactly one desktop hot update if the running environment supports
   it; otherwise report that a full dev-process restart is required.
