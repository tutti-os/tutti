import type { TranslateFn } from "../../../i18n";

export function agentProcessingLabels(t: TranslateFn) {
  return {
    processing: t("agentHost.agentGui.processing"),
    processingPreparing: t("agentHost.agentGui.processingPreparing"),
    processingSubmitting: t("agentHost.agentGui.processingSubmitting"),
    processingWaitingResponse: t(
      "agentHost.agentGui.processingWaitingResponse"
    ),
    processingThinking: t("agentHost.agentGui.processingThinking"),
    processingGenerating: t("agentHost.agentGui.processingGenerating"),
    processingUsingTool: t("agentHost.agentGui.processingUsingTool"),
    processingWaitingTool: t("agentHost.agentGui.processingWaitingTool"),
    processingReconnecting: t("agentHost.agentGui.processingReconnecting"),
    processingWaitingContinuation: t(
      "agentHost.agentGui.processingWaitingContinuation"
    ),
    processingElapsedSeconds: (seconds: number) =>
      t("agentHost.agentGui.processingElapsedSeconds", { seconds })
  };
}

export type AgentProcessingLabels = ReturnType<typeof agentProcessingLabels>;
