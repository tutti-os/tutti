export type AgentConversationFollowEndMode = "following" | "detached";

export const AGENT_CONVERSATION_REACHED_END_THRESHOLD_PX = 24;

export type AgentConversationFollowEndEvent =
  | "conversation-changed"
  | "prompt-submitted"
  | "scroll-to-end-requested"
  | "user-reached-end"
  | "user-scrolled-away";

export interface AgentConversationFollowEndController {
  dispatch(
    event: AgentConversationFollowEndEvent
  ): AgentConversationFollowEndMode;
  getSnapshot(): AgentConversationFollowEndMode;
}

function nextFollowEndMode(
  event: AgentConversationFollowEndEvent
): AgentConversationFollowEndMode {
  return event === "user-scrolled-away" ? "detached" : "following";
}

export function isAgentConversationViewportAtEnd(
  distanceFromBottomPx: number
): boolean {
  return distanceFromBottomPx <= AGENT_CONVERSATION_REACHED_END_THRESHOLD_PX;
}

export function createAgentConversationFollowEndController(): AgentConversationFollowEndController {
  let mode: AgentConversationFollowEndMode = "following";

  return {
    dispatch(event) {
      mode = nextFollowEndMode(event);
      return mode;
    },
    getSnapshot() {
      return mode;
    }
  };
}
