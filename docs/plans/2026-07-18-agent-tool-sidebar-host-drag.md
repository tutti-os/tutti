# Agent Tool Sidebar Header Ownership Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the shared Agent tool sidebar participate in either a native Electron window header or a host-owned Workbench header without creating a second header or duplicating control rules.

**Architecture:** `@tutti-os/agent-gui` remains the single owner of the tool sidebar and its interactive header boundaries. `AgentToolSidebarHeaderContract` selects exactly one Header owner (`window` or `host`) and independently declares whether that Header overlays the body or is stacked above it. The sidebar publishes structured actions, open state, and layout width through `AgentToolSidebarHeaderLayout`; the selected owner renders those actions in its one existing Header. Blank host-header gestures bubble to the host while interactive controls stop propagation.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, pnpm fixed npm release cohort.

---

### Task 1: Add the shared Header ownership contract

**Files:**

- Modify: `packages/agent/gui/workbench/tool-sidebar/AgentToolSidebar.tsx`
- Test: `packages/agent/gui/workbench/tool-sidebar/AgentToolSidebar.test.tsx`

1. Add a failing test proving host ownership creates no native window wrapper or panel Header, lets blank-header pointer and double-click events bubble, and stops control gestures.
2. Run `pnpm --filter @tutti-os/agent-gui test -- AgentToolSidebar.test.tsx` and confirm the new contract is missing.
3. Add `AgentToolSidebarHeaderContract` and `AgentToolSidebarHeaderLayout`.
4. Make ownership and body layout explicit at every consumer: Tutti Desktop selects `window + overlay`; TSH selects `host + overlay`.
5. Run the focused package test and `pnpm --filter @tutti-os/agent-gui typecheck`.

### Task 2: Validate and publish the Tutti cohort

**Files:**

- Modify only release-generated manifests during the official release workflow; do not hand-edit package versions.

1. Run `pnpm check:changed` and `pnpm release:pack:check`.
2. Commit with DCO sign-off and open a focused PR from `fix/agent-tool-sidebar-host-drag`.
3. Merge the PR, then dispatch the stable package release workflow on `main`.
4. Confirm every fixed-group package exists at the new shared version before downstream changes.

### Task 3: Integrate the TSH host Header

**Files:**

- Modify: `apps/tsh-desktop/src/app/renderer/features/workspace-agent/ui/agentToolSidebar/TshAgentToolSidebar.tsx`
- Modify: `apps/tsh-desktop/src/app/renderer/features/workspace-workbench/ui/TshAgentGuiWorkbenchHeader.tsx`
- Modify/Test: focused Workbench and Agent tool-sidebar specs
- Delete: the old accessory-only registration bridge

1. Register the structured sidebar Header layout by Agent node ID.
2. Render that layout through the existing `TshAgentGuiWorkbenchHeader`.
3. Remove panel Header placement and the old accessory-only bridge.
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
