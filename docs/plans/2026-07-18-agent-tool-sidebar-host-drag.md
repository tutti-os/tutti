# Agent Tool Sidebar Host Drag Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the shared Agent tool-sidebar header support both native Electron window dragging and host-owned Workbench dragging without downstream DOM wrappers or duplicated control rules.

**Architecture:** `@tutti-os/agent-gui` remains the single owner of the tool sidebar and its interactive header boundaries. It exposes one explicit header-drag configuration that selects native-window or host behavior and accepts host pointer/double-click handlers. Tutti Desktop keeps the default native behavior; TSH selects host behavior and routes the events through its existing Workbench drag forwarding primitive.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, pnpm fixed npm release cohort.

---

### Task 1: Add the shared drag contract

**Files:**

- Modify: `packages/agent/gui/workbench/tool-sidebar/AgentToolSidebar.tsx`
- Test: `packages/agent/gui/workbench/tool-sidebar/AgentToolSidebar.test.tsx`

1. Add a failing test proving host mode removes the native Electron drag region, forwards blank-header pointer and double-click events, and does not forward control gestures.
2. Run `pnpm --filter @tutti-os/agent-gui test -- AgentToolSidebar.test.tsx` and confirm the new contract is missing.
3. Add a narrow `headerDrag` prop with `native-window` and `host` modes plus optional pointer/double-click handlers.
4. Keep `native-window` as the default so the existing standalone consumer reuses the same component unchanged.
5. Run the focused package test and `pnpm --filter @tutti-os/agent-gui typecheck`.

### Task 2: Validate and publish the Tutti cohort

**Files:**

- Modify only release-generated manifests during the official release workflow; do not hand-edit package versions.

1. Run `pnpm check:changed` and `pnpm release:pack:check`.
2. Commit with DCO sign-off and open a focused PR from `fix/agent-tool-sidebar-host-drag`.
3. Merge the PR, then dispatch the stable package release workflow on `main`.
4. Confirm every fixed-group package exists at the new shared version before downstream changes.

### Task 3: Replace the TSH temporary bridge

**Files:**

- Modify: `apps/tsh-desktop/src/app/renderer/features/workspace-agent/ui/agentToolSidebar/TshAgentToolSidebar.tsx`
- Modify: `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/services/internal/workspaceWorkbenchWindowHeaders.ts`
- Modify/Test: focused Workbench and Agent tool-sidebar specs
- Delete: `apps/tsh-desktop/src/app/renderer/features/workspace-agent/ui/agentToolSidebar/TshAgentToolSidebarHeaderDragBridge.tsx`
- Delete: `apps/tsh-desktop/src/app/renderer/features/workspace-agent/ui/agentToolSidebar/TshAgentToolSidebarHeaderDragBridge.spec.tsx`

1. Extract the existing Workbench pointer/double-click forwarding code into reusable host helpers with regression tests.
2. Pass the helpers to the upstream `headerDrag` host contract from `TshAgentToolSidebar`.
3. Delete the temporary wrapper and selector-specific CSS override.
4. Run focused Vitest suites and `pnpm --dir apps/tsh-desktop check`.

### Task 4: Upgrade and assess the dependency cohort

**Files:**

- Modify with package-manager commands: TSH manifests and `pnpm-lock.yaml`
- Modify with Go tooling when the release cohort changes selected Go modules: `go.mod`, `go.sum`
- Modify: `.github/tutti-dependency-assessment.json`

1. Upgrade all `@tutti-os/*` and Tutti Go module cohort members to the same stable release.
2. Record whether sibling `tsh-server` can keep its current cohort because this change is renderer-only.
3. Run `pnpm check:tutti-dependencies`, `pnpm check:tutti-dependencies:graph`, `pnpm test:tutti-dependencies`, and the relevant desktop checks.
4. Confirm development HMR is sufficient; packaged builds require an application restart but no desktopd/VM restart.
