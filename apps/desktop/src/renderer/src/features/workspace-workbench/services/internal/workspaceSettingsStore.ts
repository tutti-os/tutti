import { proxy } from "valtio";
import type {
  WorkspaceDeletedConversationsMutableState,
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
    confirmingDeletePlanID: null,
    createdPlanHandoff: null,
    deleteBlock: null,
    deletingPlanID: null,
    detectingPlanID: null,
    draft: null,
    draftDiscoveredModels: [],
    draftFeedback: null,
    draftSaveImpact: null,
    duplicatingPlanID: null,
    fetchingDraftModels: false,
    loading: false,
    planFeedback: {},
    planReferenceCounts: {},
    plans: [],
    saving: false,
    togglingPlanID: null
  };
}

export function createWorkspaceDeletedConversationsState(): WorkspaceDeletedConversationsMutableState {
  return {
    hasMore: false,
    loadFailed: false,
    loadMoreFailed: false,
    loading: false,
    loadingMore: false,
    nextCursor: null,
    operationBySessionID: {},
    projectFilter: { kind: "all" },
    projectOptions: [],
    purgingAll: false,
    search: "",
    sessions: [],
    totalCount: 0,
    workspaceTotalCount: 0
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
    deletedConversations: createWorkspaceDeletedConversationsState(),
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
    workspaceID: null
  });
}
