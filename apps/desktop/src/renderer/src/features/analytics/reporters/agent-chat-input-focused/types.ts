import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AgentChatInputFocusedParams extends AnalyticsReporterParams {
  agentSessionId: string | null;
  agentTargetId: string | null;
  composerReady: boolean;
  conversationState: string;
  focusMethod: string;
  panelVisitId: string;
  provider: string;
  surface: string;
}
