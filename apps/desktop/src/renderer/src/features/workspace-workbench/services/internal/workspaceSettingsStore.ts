import { proxy } from "valtio";
import type { WorkspaceSettingsStoreState } from "../workspaceSettingsTypes";
import { readDeveloperPanelVisible } from "./developerPanelVisibility.ts";

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
    open: false,
    purgingDeletedConversations: false,
    tuttiAgentSwitchEnabled: false,
    workspaceID: null
  });
}
