import { AgentChatReadyReporter } from "../../../analytics/reporters/agent-chat-ready/agentChatReadyReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { createOptionalReporterService } from "./agentMessageSentAnalytics.ts";

export interface AgentChatReadyTracker {
  track(input: { provider: string }): Promise<void>;
}

export function createAgentChatReadyTracker(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): AgentChatReadyTracker {
  return {
    async track(event) {
      await new AgentChatReadyReporter(
        { provider: event.provider },
        {
          reporterService: createOptionalReporterService(input.reporterService),
          now: input.reporterNow
        }
      ).report();
    }
  };
}
