import type { AnalyticsReporterParams } from "../baseReporter.ts";
import type { AgentAnalyticsErrorCode } from "../agent-error-fields.ts";

export interface ErrorAgentSessionFailedParams extends AnalyticsReporterParams {
  agentSessionId: string;
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
  isRetryable: boolean;
  provider: string;
}
