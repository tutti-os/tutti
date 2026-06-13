import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "index.ts",
    "agent-message-center/index": "agent-message-center/index.ts",
    "agent-rich-text-at-provider":
      "agent-gui/agentGuiNode/agentRichTextAtProvider.ts",
    "agent-title-text": "shared/utils/agentTitleText.ts",
    "i18n/index": "i18n/index.ts",
    "mention-file-presentation": "agent-gui/shared/mentionFilePresentation.ts",
    "workbench/index": "workbench/index.ts",
    "workbench/contribution": "workbench/contribution.ts",
    "workbench/launch": "workbench/launch.ts",
    "workbench/providerCatalog": "workbench/providerCatalog.ts",
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
