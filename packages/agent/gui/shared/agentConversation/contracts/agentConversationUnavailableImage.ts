import type { ReactNode } from "react";

export type AgentConversationUnavailableImageSource =
  | "user-message"
  | "assistant-markdown"
  | "image-generation-tool";

export type AgentConversationUnavailableImageReason =
  | "unavailable"
  | "read-failed"
  | "load-failed";

export interface AgentConversationUnavailableImageContext {
  source: AgentConversationUnavailableImageSource;
  reason: AgentConversationUnavailableImageReason;
  alt: string;
}

export type AgentConversationUnavailableImageRenderer = (
  context: AgentConversationUnavailableImageContext
) => ReactNode;
