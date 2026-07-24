export const agentGUIBuildEntries = {
  index: "index.ts",
  "agent-gui": "AgentGUI.tsx",
  "startup-shell": "AgentGUIStartupShell.tsx",
  agents: "agents.ts",
  "custom-mention": "custom-mention.ts",
  "dock-icons": "dockIcons.ts",
  layout: "layout.ts",
  "mention-search": "agent-gui/agentGuiNode/AgentMentionSearchController.ts",
  "agent-message-center/index": "agent-message-center/index.ts",
  "agent-conversation/index": "agent-conversation/index.ts",
  "agent-conversation/interactive-answer":
    "shared/agentConversation/interactiveAnswerPayload.ts",
  "agent-env/index": "shared/agentEnv/index.ts",
  "agent-env/ui": "shared/agentEnv/ui.ts",
  "workspace-settings-panel":
    "shared/workspaceSettingsPanel/workspaceSettingsPanelStore.ts",
  "context-mention-palette/index": "context-mention-palette/index.ts",
  "context-mention-provider":
    "agent-gui/agentGuiNode/agentContextMentionProvider.ts",
  "agent-title-text": "shared/utils/agentTitleText.ts",
  "provider-identity": "provider-identity.ts",
  "provider-icons": "provider-icons.ts",
  "i18n/index": "i18n/index.ts",
  "mention-file-presentation": "agent-gui/shared/mentionFilePresentation.ts",
  "workbench/index": "workbench/index.ts",
  "workbench/contribution": "workbench/contribution.ts",
  "workbench/launch": "workbench/launch.ts",
  "workbench/providerCatalog": "workbench/providerCatalog.ts",
  "workbench/sessionTitle": "workbench/sessionTitle.ts",
  "workbench/state": "workbench/state.ts",
  "workbench/browser-element-context/index":
    "workbench/browser-element-context/index.ts",
  "workbench/tool-sidebar/index": "workbench/tool-sidebar/index.ts",
  "workbench/types": "workbench/types.ts",
  "workspace-agent-generated-files": "shared/workspaceAgentGeneratedFiles.ts",
  "conversation-rail-runtime": "agentConversationRailRuntime.ts",
  "workspace-query-cache": "shared/query/workspaceQueryCache.ts"
} as const;

type AgentGUIBuildEntry = keyof typeof agentGUIBuildEntries;

export const agentGUIDtsEntryGroups = [
  ["index"],
  [
    "agent-gui",
    "startup-shell",
    "agents",
    "mention-search",
    "agent-message-center/index",
    "agent-conversation/index",
    "agent-conversation/interactive-answer",
    "context-mention-palette/index",
    "context-mention-provider"
  ],
  [
    "custom-mention",
    "agent-env/index",
    "agent-env/ui",
    "workspace-settings-panel",
    "provider-identity",
    "provider-icons",
    "i18n/index",
    "mention-file-presentation",
    "agent-title-text",
    "workspace-agent-generated-files",
    "conversation-rail-runtime",
    "workspace-query-cache"
  ],
  [
    "dock-icons",
    "layout",
    "workbench/index",
    "workbench/contribution",
    "workbench/launch",
    "workbench/providerCatalog",
    "workbench/sessionTitle",
    "workbench/state",
    "workbench/browser-element-context/index",
    "workbench/tool-sidebar/index",
    "workbench/types"
  ]
] as const satisfies readonly (readonly AgentGUIBuildEntry[])[];
