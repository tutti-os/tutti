import {
  AgentAnalyticsErrorCode,
  agentAnalyticsErrorFields,
  agentAnalyticsSuccessFields,
  type AgentAnalyticsErrorFields
} from "../../../analytics/reporters/agent-error-fields.ts";
import { AgentNodeResultReporter } from "../../../analytics/reporters/agent-node-result/agentNodeResultReporter.ts";
import type {
  AgentAnalyticsFlow,
  AgentAnalyticsNode,
  AgentAnalyticsNodeStatus
} from "../../../analytics/reporters/agent-node-result/types.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { createOptionalReporterService } from "./agentMessageSentAnalytics.ts";

export { AgentAnalyticsErrorCode } from "../../../analytics/reporters/agent-error-fields.ts";
export type {
  AgentAnalyticsFlow,
  AgentAnalyticsNode
} from "../../../analytics/reporters/agent-node-result/types.ts";

export interface AgentNodeResultTracker {
  track(input: AgentNodeResultInput): Promise<void>;
}

export interface AgentNodeResultInput {
  agentSessionId?: string | null;
  durationMs?: number | null;
  error?: unknown;
  fallbackErrorCode?: AgentAnalyticsErrorCode;
  flow?: AgentAnalyticsFlow;
  node?: AgentAnalyticsNode;
  nodeName?: string;
  provider?: string | null;
  status?: AgentAnalyticsNodeStatus;
  success: boolean;
}

export function createAgentNodeResultTracker(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): AgentNodeResultTracker {
  return {
    async track(result) {
      const errorFields = resolveNodeResultErrorFields(result);
      await new AgentNodeResultReporter(
        {
          agentSessionId: result.agentSessionId ?? null,
          durationMs: result.durationMs ?? null,
          ...errorFields,
          flow: result.flow ?? inferLegacyFlow(result.nodeName),
          node: result.node ?? inferLegacyNode(result.nodeName),
          nodeName: result.nodeName ?? result.node ?? "runtime_exec",
          provider: result.provider ?? null,
          status: result.status ?? (result.success ? "success" : "failure"),
          success: result.success
        },
        {
          reporterService: createOptionalReporterService(input.reporterService),
          now: input.reporterNow
        }
      ).report();
    }
  };
}

function inferLegacyFlow(nodeName: string | undefined): AgentAnalyticsFlow {
  switch (nodeName) {
    case "provider_install":
    case "provider_login":
      return "provider_setup";
    case "send_message":
      return "message_send";
    default:
      return "session_create";
  }
}

function inferLegacyNode(nodeName: string | undefined): AgentAnalyticsNode {
  switch (nodeName) {
    case "create_session":
    case "resume_session":
      return "activate_session";
    case "prompt_validate":
      return "prompt_validated";
    case "provider_install":
      return "install_action_requested";
    case "provider_login":
      return "login_action_requested";
    case "send_message":
      return "message_sent_reported";
    default:
      return "runtime_exec";
  }
}

export async function safeTrackAgentNodeResult(
  tracker: AgentNodeResultTracker,
  input: AgentNodeResultInput
): Promise<void> {
  try {
    await tracker.track(input);
  } catch {
    // Analytics must not block agent flows.
  }
}

function resolveNodeResultErrorFields(
  input: AgentNodeResultInput
): AgentAnalyticsErrorFields {
  if (input.success) {
    return agentAnalyticsSuccessFields;
  }
  return agentAnalyticsErrorFields(
    input.error,
    input.fallbackErrorCode ?? AgentAnalyticsErrorCode.Unknown
  );
}
