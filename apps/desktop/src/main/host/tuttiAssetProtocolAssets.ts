export const tuttiAssetProtocolAssets = {
  "agent/claudecode-mask.svg":
    "../../packages/agent/gui/app/renderer/assets/icons/agents/claudecode-flat-filled.svg",
  "agent/claudecode.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/claudecode.png",
  "agent/codex-mask.svg":
    "../../packages/agent/gui/app/renderer/assets/icons/agents/codex-flat-filled.svg",
  "agent/codex.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/codex.png",
  "agent/cursor-mask.svg":
    "../../packages/agent/gui/app/renderer/assets/icons/agents/cursor-flat-filled.svg",
  "agent/cursor.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/cursor.png",
  "agent/openclaw.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/openclaw.png",
  "agent/opencode-mask.svg":
    "../../packages/agent/gui/app/renderer/assets/icons/agents/opencode-flat-filled.svg",
  "agent/opencode.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/opencode.png",
  "agent/tutti-mask.svg":
    "../../packages/agent/gui/app/renderer/assets/icons/agents/tutti-flat-filled.svg",
  "agent/tutti.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/tutti.png",
  "file/default.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/apps/document.png",
  "folder/default.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/files.png",
  "issue/default.png":
    "src/renderer/src/assets/workspace-canvas/dock/default/issue.png"
} as const;

export type TuttiAssetProtocolRoute = keyof typeof tuttiAssetProtocolAssets;
