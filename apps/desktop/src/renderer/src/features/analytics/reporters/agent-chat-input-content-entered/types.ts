import type { AgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";

export interface AgentChatInputContentEnteredParams extends AgentChatEngagementBaseParams {
  contentType: "image" | "large_text" | "text";
  hadPrefill: boolean;
}
