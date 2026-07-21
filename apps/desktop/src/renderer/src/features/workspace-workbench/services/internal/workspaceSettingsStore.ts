import { proxy } from "valtio";
import type {
  WorkspaceSettingsAutomationRulesMutableState,
  WorkspaceSettingsModelPlansMutableState,
  WorkspaceSettingsStoreState,
  WorkspaceSettingsWorkspaceAgentsMutableState
} from "../workspaceSettingsTypes";
import { readDeveloperPanelVisible } from "./developerPanelVisibility.ts";

export function createWorkspaceSettingsAgentsState(): WorkspaceSettingsWorkspaceAgentsMutableState {
  return {
    agents: [],
    confirmingDeleteAgentID: null,
    deletingAgentID: null,
    draft: null,
    feedback: null,
    capabilityCatalog: [],
    capabilityCatalogHarnessTargetID: null,
    capabilityCatalogLoadFailed: false,
    capabilityCatalogLoading: false,
    harnessTargets: [],
    loadFailed: false,
    loading: false,
    generating: false,
    recommendingFallback: false,
    saving: false
  };
}

export function createWorkspaceSettingsAutomationRulesState(): WorkspaceSettingsAutomationRulesMutableState {
  return {
    rules: []
  };
}

export function createWorkspaceSettingsModelPlansState(): WorkspaceSettingsModelPlansMutableState {
  return {
    plans: []
  };
}

export function createWorkspaceSettingsStore(): WorkspaceSettingsStoreState {
  return proxy({
    activeSection: "general",
    agentTab: "general",
    agentFocusProvider: null,
    agentFocusRequestID: 0,
    agents: createWorkspaceSettingsAgentsState(),
    automationRules: createWorkspaceSettingsAutomationRulesState(),
    developerPanelVisible: readDeveloperPanelVisible(),
    developerLogs: {
      clearing: false,
      clearingConversationHistory: false,
      exporting: false,
      loading: false,
      logs: null
    },
    generalFocusAnchor: null,
    generalFocusRequestID: 0,
    managedModels: {
      deletingProvider: null,
      detectingProvider: null,
      draft: null,
      feedback: {},
      focusedProvider: null,
      focusRequestID: 0,
      loading: false,
      providers: [],
      savingProvider: null,
      testingProvider: null
    },
    modelPlans: createWorkspaceSettingsModelPlansState(),
    open: false,
    purgingDeletedConversations: false,
    tuttiAgentSwitchEnabled: false,
    workspaceID: null
  });
}
