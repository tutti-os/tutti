import type { AgentConversationFollowEndMode } from "../../../shared/agentConversation/agentConversationFollowEndController";

export interface TimelineScrollAnchor {
  conversationId: string;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

interface ConversationScrollMemory {
  anchor: TimelineScrollAnchor;
  followEndMode: AgentConversationFollowEndMode;
}

export class AgentGUIConversationScrollMemory {
  private readonly memoryByConversationId = new Map<
    string,
    ConversationScrollMemory
  >();

  read(conversationId: string): ConversationScrollMemory | undefined {
    return this.memoryByConversationId.get(conversationId);
  }

  write(
    anchor: TimelineScrollAnchor,
    followEndMode: AgentConversationFollowEndMode
  ): void {
    this.memoryByConversationId.set(anchor.conversationId, {
      anchor,
      followEndMode
    });
  }
}
