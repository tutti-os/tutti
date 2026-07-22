import { proxy } from "valtio";
import type {
  WorkspaceSettingsModelPlansMutableState,
  WorkspaceSettingsStoreState,
  WorkspaceSettingsWorkspaceAgentsMutableState,
  WorkspaceSettingsAutomationRulesMutableState
} from "../workspaceSettingsTypes";
import { readDeveloperPanelVisible } from "./developerPanelVisibility.ts";

export function createWorkspaceSettingsAgentsState(): WorkspaceSettingsWorkspaceAgentsMutableState {
  return {
    agents: [],
    confirmingDeleteAgentID: null,
    deletingAgentID: null,
    draft: null,
    feedback: null,
    harnessTargets: [],
    loadFailed: false,
    loading: false,
    saving: false
  };
}

export function createWorkspaceSettingsAutomationRulesState(): WorkspaceSettingsAutomationRulesMutableState {
  return {
    confirmingDeleteRuleID: null,
    deletingRuleID: null,
    draft: null,
    feedback: null,
    loadFailed: false,
    loading: false,
    rules: [],
    saving: false,
    targetCatalog: null,
    targetOptions: []
  };
}

export function createWorkspaceSettingsModelPlansState(): WorkspaceSettingsModelPlansMutableState {
  return {
    bindings: {
      agentTargets: [],
      bindings: [],
      loadFailed: false,
      loading: false,
      saveFailedTargetID: null,
      savingTargetID: null
    },
    confirmingDeletePlanID: null,
    deleteBlock: null,
    deletingPlanID: null,
    detecting: false,
    draft: null,
    draftDetection: null,
    draftDiscoveredModels: [],
    draftFeedback: null,
    draftSaveImpact: null,
    duplicatingPlanID: null,
    fetchingDraftModels: false,
    loading: false,
    planFeedback: {},
    plans: [],
    saving: false,
    togglingPlanID: null
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
    modelPlans: createWorkspaceSettingsModelPlansState(),
    open: false,
    purgingDeletedConversations: false,
    tuttiAgentSwitchEnabled: false,
    workspaceID: null
  });
}
