import { proxy } from "valtio";
import type {
  WorkspaceSettingsModelPlansMutableState,
  WorkspaceSettingsStoreState
} from "../workspaceSettingsTypes";
import { readDeveloperPanelVisible } from "./developerPanelVisibility.ts";

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
    duplicatingPlanID: null,
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
    tuttiAgentSwitchEnabled: false,
    workspaceID: null
  });
}
