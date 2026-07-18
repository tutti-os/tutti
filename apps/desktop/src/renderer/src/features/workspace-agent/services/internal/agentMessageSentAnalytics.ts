import { AgentMessageSentReporter } from "../../../analytics/reporters/agent-message-sent/agentMessageSentReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";

export interface AgentMessageSentTracker {
  track(input: {
    agentSessionId: string;
    clientSubmitId?: string;
    isQueued?: boolean;
    prompt: string;
    provider: string;
  }): Promise<void>;
}

export function createAgentMessageSentTracker(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): AgentMessageSentTracker {
  const messageCountsByAgentSessionId = new Map<string, number>();
  const reportedClientSubmitIds = new Set<string>();
  return {
    async track(message) {
      const clientSubmitId = message.clientSubmitId?.trim() ?? "";
      if (clientSubmitId) {
        if (reportedClientSubmitIds.has(clientSubmitId)) {
          return;
        }
        reportedClientSubmitIds.add(clientSubmitId);
      }
      const conversationIndex =
        (messageCountsByAgentSessionId.get(message.agentSessionId) ?? 0) + 1;
      messageCountsByAgentSessionId.set(
        message.agentSessionId,
        conversationIndex
      );
      await new AgentMessageSentReporter(
        {
          agentSessionId: message.agentSessionId,
          conversationIndex,
          hasFileMention: hasAgentMessageFileMention(message.prompt),
          hasSlashCommand: hasAgentMessageSlashCommand(message.prompt),
          isQueued: message.isQueued === true,
          provider: message.provider
        },
        {
          reporterService: createOptionalReporterService(input.reporterService),
          now: input.reporterNow
        }
      ).report();
    }
  };
}

export function createOptionalReporterService(
  reporterService: Pick<IReporterService, "trackEvents"> | undefined
): Pick<IReporterService, "trackEvents"> {
  return (
    reporterService ?? {
      trackEvents() {
        return Promise.resolve();
      }
    }
  );
}

function hasAgentMessageSlashCommand(prompt: string): boolean {
  return prompt.trimStart().startsWith("/");
}

function hasAgentMessageFileMention(prompt: string): boolean {
  return /mention:\/\/file\/|@\[[^\]]+\]\(/u.test(prompt);
}
