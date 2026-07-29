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

const MAX_CONVERSATION_SCROLL_MEMORY_ENTRIES = 64;

export class AgentGUIConversationScrollMemory {
  private readonly memoryByConversationId = new Map<
    string,
    ConversationScrollMemory
  >();

  constructor(
    private readonly maxEntries = MAX_CONVERSATION_SCROLL_MEMORY_ENTRIES
  ) {}

  read(conversationId: string): ConversationScrollMemory | undefined {
    const memory = this.memoryByConversationId.get(conversationId);
    if (!memory) {
      return undefined;
    }
    this.touch(conversationId, memory);
    return memory;
  }

  write(
    anchor: TimelineScrollAnchor,
    followEndMode: AgentConversationFollowEndMode
  ): void {
    this.touch(anchor.conversationId, {
      anchor,
      followEndMode
    });
    while (this.memoryByConversationId.size > this.maxEntries) {
      const oldestConversationId = this.memoryByConversationId
        .keys()
        .next().value;
      if (oldestConversationId === undefined) {
        return;
      }
      this.memoryByConversationId.delete(oldestConversationId);
    }
  }

  private touch(
    conversationId: string,
    memory: ConversationScrollMemory
  ): void {
    this.memoryByConversationId.delete(conversationId);
    this.memoryByConversationId.set(conversationId, memory);
  }
}
