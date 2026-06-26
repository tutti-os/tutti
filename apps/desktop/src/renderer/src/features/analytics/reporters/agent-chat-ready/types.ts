import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AgentChatReadyParams extends AnalyticsReporterParams {
  provider: string;
}
