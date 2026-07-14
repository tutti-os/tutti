import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AgentChatInputContentEnteredParams extends AnalyticsReporterParams {
  agentSessionId: string | null;
  agentTargetId: string | null;
  composerReady: boolean;
  contentType: string;
  conversationState: string;
  hadPrefill: boolean;
  panelVisitId: string;
  provider: string;
  surface: string;
}
