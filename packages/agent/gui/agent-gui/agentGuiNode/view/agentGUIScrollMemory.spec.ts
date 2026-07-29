import { describe, expect, it } from "vitest";
import { AgentGUIConversationScrollMemory } from "./agentGUIScrollMemory";

describe("AgentGUIConversationScrollMemory", () => {
  it("evicts the least recently used conversation beyond its entry limit", () => {
    const memory = new AgentGUIConversationScrollMemory(2);

    memory.write(anchor("conversation-a", 100), "detached");
    memory.write(anchor("conversation-b", 200), "detached");
    expect(memory.read("conversation-a")?.anchor.scrollTop).toBe(100);

    memory.write(anchor("conversation-c", 300), "detached");

    expect(memory.read("conversation-a")?.anchor.scrollTop).toBe(100);
    expect(memory.read("conversation-b")).toBeUndefined();
    expect(memory.read("conversation-c")?.anchor.scrollTop).toBe(300);
  });
});

function anchor(conversationId: string, scrollTop: number) {
  return {
    clientHeight: 100,
    conversationId,
    scrollHeight: 1_000,
    scrollTop
  };
}
