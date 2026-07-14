import type {
  AgentGUIEngagementAnalytics,
  AgentGUIEngagementEventContext
} from "@tutti-os/agent-gui";
import { AgentChatInputContentEnteredReporter } from "../../../analytics/reporters/agent-chat-input-content-entered/agentChatInputContentEnteredReporter.ts";
import { AgentChatInputFocusedReporter } from "../../../analytics/reporters/agent-chat-input-focused/agentChatInputFocusedReporter.ts";
import { AgentChatPanelExposedReporter } from "../../../analytics/reporters/agent-chat-panel-exposed/agentChatPanelExposedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { createOptionalReporterService } from "./agentMessageSentAnalytics.ts";

export type AgentGUIAnalyticsSurface = "standalone_agent" | "workspace";

export function createAgentGUIEngagementAnalytics(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  surface: AgentGUIAnalyticsSurface;
}): AgentGUIEngagementAnalytics {
  const dependencies = {
    reporterService: createOptionalReporterService(input.reporterService),
    now: input.reporterNow
  };
  return {
    async onChatPanelExposed(event) {
      await new AgentChatPanelExposedReporter(
        { ...baseParams(event, input.surface) },
        dependencies
      ).report();
    },
    async onChatInputFocused(event) {
      await new AgentChatInputFocusedReporter(
        {
          ...baseParams(event, input.surface),
          focusMethod: event.focusMethod
        },
        dependencies
      ).report();
    },
    async onChatInputContentEntered(event) {
      await new AgentChatInputContentEnteredReporter(
        {
          ...baseParams(event, input.surface),
          contentType: event.contentType,
          hadPrefill: event.hadPrefill
        },
        dependencies
      ).report();
    }
  };
}

function baseParams(
  event: AgentGUIEngagementEventContext,
  surface: AgentGUIAnalyticsSurface
) {
  return {
    agentSessionId: event.agentSessionId,
    agentTargetId: event.agentTargetId,
    composerReady: event.composerReady,
    conversationState: event.conversationState,
    panelVisitId: event.panelVisitId,
    provider: event.provider,
    surface
  };
}
