import type {
  AgentGUIEngagementEvent,
  AgentGUIEngagementEventSink
} from "@tutti-os/agent-gui";
import { AgentChatInputContentEnteredReporter } from "../../../analytics/reporters/agent-chat-input-content-entered/agentChatInputContentEnteredReporter.ts";
import { AgentChatInputFocusedReporter } from "../../../analytics/reporters/agent-chat-input-focused/agentChatInputFocusedReporter.ts";
import { AgentChatPanelExposedReporter } from "../../../analytics/reporters/agent-chat-panel-exposed/agentChatPanelExposedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { createOptionalReporterService } from "./agentMessageSentAnalytics.ts";

export type AgentGUIAnalyticsSurface = "standalone_agent" | "workspace";

export function createAgentGUIEngagementEventSink(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  surface: AgentGUIAnalyticsSurface;
}): AgentGUIEngagementEventSink {
  const dependencies = {
    reporterService: createOptionalReporterService(input.reporterService),
    now: input.reporterNow
  };
  return async (event) => {
    const baseParams = engagementBaseParams(event, input.surface);
    switch (event.type) {
      case "panel_exposed":
        await new AgentChatPanelExposedReporter(
          baseParams,
          dependencies
        ).report();
        return;
      case "composer_focused":
        await new AgentChatInputFocusedReporter(
          { ...baseParams, focusMethod: event.focusMethod },
          dependencies
        ).report();
        return;
      case "composer_content_entered":
        await new AgentChatInputContentEnteredReporter(
          {
            ...baseParams,
            contentType: event.contentType,
            hadPrefill: event.hadPrefill
          },
          dependencies
        ).report();
    }
  };
}

function engagementBaseParams(
  event: AgentGUIEngagementEvent,
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
