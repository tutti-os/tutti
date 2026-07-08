import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import {
  getAgentEnvPanelStore,
  type AgentEnvPanelRequest
} from "@tutti-os/agent-gui/agent-env";
import type { AgentProviderStatusService } from "@renderer/features/workspace-agent";
import { runWorkspaceAgentProviderDockAction } from "./workspaceAgentProviderDockActions.ts";
import { workspaceAgentGuiDockEntryId } from "./workspaceWorkbenchComposition.ts";

const host = { launchNode: async () => null } as unknown as WorkbenchHostHandle;

test("dock install link opens the wizard with install focus, runs nothing", async () => {
  const forwarded: string[] = [];
  await runWorkspaceAgentProviderDockAction({
    actionId: "install",
    agentProviderStatusService: stubService((id) => forwarded.push(id)),
    entryId: workspaceAgentGuiDockEntryId("codex"),
    host,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(forwarded, []);
  assertPanel({ open: true, provider: "codex", focus: "install" });
});

test("dock login link opens the wizard with auth focus, runs nothing", async () => {
  const forwarded: string[] = [];
  await runWorkspaceAgentProviderDockAction({
    actionId: "login",
    agentProviderStatusService: stubService((id) => forwarded.push(id)),
    entryId: workspaceAgentGuiDockEntryId("codex"),
    host,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(forwarded, []);
  assertPanel({ open: true, provider: "codex", focus: "auth" });
});

test("dock re-detect link opens the wizard at detect focus, runs nothing", async () => {
  getAgentEnvPanelStore().open = false;
  const forwarded: string[] = [];
  await runWorkspaceAgentProviderDockAction({
    actionId: "refresh",
    agentProviderStatusService: stubService((id) => forwarded.push(id)),
    entryId: workspaceAgentGuiDockEntryId("codex"),
    host,
    workspaceId: "workspace-1"
  });
  // Re-detect now surfaces in the wizard (which runs detection there) rather
  // than silently re-probing in the background.
  assert.deepEqual(forwarded, []);
  assertPanel({ open: true, provider: "codex", focus: "detect" });
});

test("non-agent dock entries are ignored", async () => {
  getAgentEnvPanelStore().open = false;
  const forwarded: string[] = [];
  await runWorkspaceAgentProviderDockAction({
    actionId: "login",
    agentProviderStatusService: stubService((id) => forwarded.push(id)),
    entryId: "workspace-files",
    host,
    workspaceId: "workspace-1"
  });
  assert.deepEqual(forwarded, []);
  assert.equal(getAgentEnvPanelStore().open, false);
});

function assertPanel(expected: Partial<AgentEnvPanelRequest>) {
  const store = getAgentEnvPanelStore();
  assert.equal(store.open, expected.open);
  assert.equal(store.provider, expected.provider);
  assert.equal(store.focus, expected.focus);
}

function stubService(
  onRun: (actionId: string) => void
): AgentProviderStatusService {
  return {
    _serviceBrand: undefined,
    getRevision: () => 0,
    getSnapshot: () => ({
      capturedAt: null,
      defaultProvider: null,
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: []
    }),
    getStatus: () => null,
    hydrate: () => {},
    isActionPending: () => false,
    ensureLoaded: async () => null,
    refresh: async () => {},
    runAction: async (_provider, actionId) => {
      onRun(actionId);
    },
    subscribe: () => () => {},
    getDiagnosticsConsent: () => false,
    setDiagnosticsConsent: () => {},
    reportEnvIssue: async () => {}
  };
}
