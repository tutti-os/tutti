import type { AnalyticsReporterParams } from "../baseReporter.ts";
import type { AgentAnalyticsErrorCode } from "../../../workspace-agent/agentAnalyticsError.ts";

export interface AgentProviderLoginResultParams extends AnalyticsReporterParams {
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
  errorReason: string | null;
  provider: string;
  success: boolean;
}
