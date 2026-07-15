import type { AgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";

export interface AgentChatInputFocusedParams extends AgentChatEngagementBaseParams {
  focusMethod: "keyboard" | "pointer" | "programmatic";
}
