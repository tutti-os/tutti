import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AgentSettingsProjectChangedParams extends AnalyticsReporterParams {
  action: string;
  agentSessionId: string | null;
  provider: string;
}
