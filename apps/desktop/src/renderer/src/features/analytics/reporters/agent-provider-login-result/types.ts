import type { AnalyticsReporterParams } from "../baseReporter.ts";
import type { AgentAnalyticsErrorCode } from "../agent-error-fields.ts";

export interface AgentProviderLoginResultParams extends AnalyticsReporterParams {
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
  errorReason: string | null;
  provider: string;
  success: boolean;
}
