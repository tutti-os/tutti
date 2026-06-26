import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AgentProviderReadyParams extends AnalyticsReporterParams {
  becameReadyVia: string;
  previousStatus: string;
  provider: string;
}
