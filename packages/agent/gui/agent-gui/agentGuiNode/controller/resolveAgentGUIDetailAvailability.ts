import type { SessionAvailabilityStatus } from "@tutti-os/agent-activity-core";
import type { AgentGUIDetailViewModel } from "../model/agentGuiNodeTypes";

/**
 * Maps activity-core session lifecycle availability into AgentGUI detail chrome.
 * Lifecycle correctness (creating/deleted/missing/failed) comes only from
 * `selectSessionAvailability`; GUI retains loading and detail-error presentation.
 */
export function resolveAgentGUIDetailAvailability(input: {
  activeConversationId: string | null | undefined;
  detailError: string | null | undefined;
  isLoadingMessages: boolean;
  sessionAvailability: SessionAvailabilityStatus;
}): AgentGUIDetailViewModel["availability"] {
  if (!input.activeConversationId?.trim()) {
    return "ready";
  }
  switch (input.sessionAvailability) {
    case "creating":
      return input.isLoadingMessages ? "loading" : "ready";
    case "deleted":
    case "missing":
      return "not_found";
    case "failed":
      return "error";
    case "loading":
      return "loading";
    case "available":
      if (input.isLoadingMessages) return "loading";
      if (input.detailError?.trim()) return "error";
      return "ready";
  }
}
