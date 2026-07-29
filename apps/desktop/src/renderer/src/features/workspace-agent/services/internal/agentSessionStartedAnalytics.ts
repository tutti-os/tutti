import { AgentSessionStartedReporter } from "../../../analytics/reporters/agent-session-started/agentSessionStartedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import { createOptionalReporterService } from "./agentMessageSentAnalytics.ts";

export interface AgentSessionStartedTracker {
  track(input: {
    agentSessionId: string;
    clientSubmitId?: string;
    hasProject: boolean;
    model?: string | null;
    permissionMode: string | null;
    provider: string;
    source: string;
  }): Promise<void>;
}

export function createAgentSessionStartedTracker(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): AgentSessionStartedTracker {
  const reportedClientSubmitIds = new Set<string>();
  return {
    async track(session) {
      const clientSubmitId = session.clientSubmitId?.trim() ?? "";
      if (clientSubmitId) {
        if (reportedClientSubmitIds.has(clientSubmitId)) {
          return;
        }
        reportedClientSubmitIds.add(clientSubmitId);
      }
      await new AgentSessionStartedReporter(
        {
          agentSessionId: session.agentSessionId,
          hasCustomModel: isCustomAgentSessionModel(session.model),
          hasProject: session.hasProject,
          permissionMode: session.permissionMode,
          provider: session.provider,
          source: session.source
        },
        {
          reporterService: createOptionalReporterService(input.reporterService),
          now: input.reporterNow
        }
      ).report();
    }
  };
}

export function resolveAgentSessionSource(input: {
  mode: "existing" | "new";
  source?: string;
}): string {
  const source = input.source?.trim();
  if (source) {
    return source;
  }
  return input.mode === "existing" ? "resume" : "launchpad";
}

export function isCustomAgentSessionModel(
  model: string | null | undefined
): boolean {
  const normalized = model?.trim().toLowerCase() ?? "";
  return normalized.startsWith("custom:") || normalized === "custom";
}
