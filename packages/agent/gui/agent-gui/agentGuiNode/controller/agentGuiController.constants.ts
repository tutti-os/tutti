// Agent GUI controller — shared constants and empty collections.

import type { AgentProviderId } from "../../../shared/contracts/dto";
import type {
  AgentModelCatalogInvalidatedEvent,
  AgentSessionCommand
} from "../../../shared/agentSessionTypes";
import type { WorkspaceAgentActivityMessage } from "../../../shared/workspaceAgentActivityTypes";

export const EMPTY_AGENT_GUI_MESSAGES: readonly WorkspaceAgentActivityMessage[] =
  [];
export const EMPTY_AGENT_GUI_AVAILABLE_COMMANDS: AgentSessionCommand[] = [];
export const ACTIVITY_STREAM_STATE_RELOAD_DEBOUNCE_MS = 150;

export function mergeAgentModelCatalogInvalidationEvents(
  events: AgentModelCatalogInvalidatedEvent[]
): AgentModelCatalogInvalidatedEvent {
  const providers = new Set<AgentProviderId>();
  let occurredAtUnixMs = 0;
  for (const event of events) {
    occurredAtUnixMs = Math.max(occurredAtUnixMs, event.occurredAtUnixMs);
    for (const provider of event.providers) {
      providers.add(provider);
    }
  }
  const lastEvent = events[events.length - 1]!;
  return {
    ...lastEvent,
    providers: [...providers],
    occurredAtUnixMs: occurredAtUnixMs || lastEvent.occurredAtUnixMs
  };
}
export const AGENT_PROVIDER_SESSION_NOT_FOUND_ERROR =
  "agent.provider_session_not_found";
export const AGENT_RESUME_SESSION_NOT_LOCAL_ERROR =
  "agent.resume_session_not_local";
export const AGENT_SETTINGS_REQUIRE_NEW_SESSION_ERROR =
  "agent.settings_require_new_session";
export const AGENT_SESSION_NOT_FOUND_ERROR = "session.not_found";
export const AGENT_SESSION_ACTIVE_TURN_CONFLICT_MESSAGE =
  "agent session already has an active turn";
export const AGENT_PROVIDER_SESSION_NOT_FOUND_FALLBACK_MESSAGE =
  "The previous agent session can no longer be restored.";
export const AGENT_RESUME_SESSION_NOT_LOCAL_FALLBACK_MESSAGE =
  "The previous agent session is not available on this machine.";
export const AGENT_GUI_CAUGHT_ERROR_STACK_LIMIT = 4000;
export const NODE_DEFAULT_DRAFT_KEY = "__agent_gui_node_defaults__";
