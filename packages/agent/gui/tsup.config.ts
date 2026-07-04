import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "index.ts",
    "agent-message-center/index": "agent-message-center/index.ts",
    "agent-conversation/index": "agent-conversation/index.ts",
    "agent-env/index": "shared/agentEnv/index.ts",
    "context-mention-palette/index": "context-mention-palette/index.ts",
    "context-mention-provider":
      "agent-gui/agentGuiNode/agentContextMentionProvider.ts",
    "agent-title-text": "shared/utils/agentTitleText.ts",
    "queued-prompt-runtime": "agentQueuedPromptRuntimeCore.ts",
    "i18n/index": "i18n/index.ts",
    "mention-file-presentation": "agent-gui/shared/mentionFilePresentation.ts",
    "plan-decision-ops": "shared/agentConversation/planImplementation.ts",
    "workbench/index": "workbench/index.ts",
    "workbench/contribution": "workbench/contribution.ts",
    "workbench/launch": "workbench/launch.ts",
    "workbench/providerCatalog": "workbench/providerCatalog.ts",
    "workbench/sessionTitle": "workbench/sessionTitle.ts",
    "workbench/state": "workbench/state.ts",
    "workbench/types": "workbench/types.ts",
    "workspace-agent-generated-files":
      "shared/workspaceAgentActivityListViewModel.ts"
  },
  external: ["react", "react-dom"],
  format: ["esm"],
  loader: {
    ".png": "dataurl"
  },
  sourcemap: true
});
