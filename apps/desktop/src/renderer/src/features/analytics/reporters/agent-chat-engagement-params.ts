import type { AnalyticsReporterParams } from "./baseReporter.ts";

export interface AgentChatEngagementBaseParams {
  agentSessionId: string | null;
  agentTargetId: string | null;
  composerReady: boolean;
  conversationState: "existing" | "new";
  panelVisitId: string;
  provider: string;
  surface: "standalone_agent" | "workspace";
}

export function projectAgentChatEngagementBaseParams(
  params: AgentChatEngagementBaseParams
): AnalyticsReporterParams {
  return {
    agentSessionId: params.agentSessionId,
    agentTargetId: params.agentTargetId,
    composerReady: params.composerReady,
    conversationState: params.conversationState,
    panelVisitId: params.panelVisitId,
    provider: params.provider,
    surface: params.surface
  };
}
