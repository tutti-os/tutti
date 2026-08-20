import type { AgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";

export type AgentQuickPromptEngagementParams = AgentChatEngagementBaseParams &
  (
    | {
        action: "panel_opened";
        source: "composer_input";
      }
    | {
        action: "prompt_used";
        promptType: "saved" | "recommended_template";
        source: "composer_input";
      }
  );
