import { describe, expect, it } from "vitest";
import { resolveAgentConversationNavigationAction } from "./agentConversationNavigationActions";

describe("resolveAgentConversationNavigationAction", () => {
  it("keeps the portable action set to URLs and Agent Sessions", () => {
    expect(
      resolveAgentConversationNavigationAction({
        href: "mention://agent-session/session-1?workspaceId=workspace-1",
        source: "agent-markdown"
      })
    ).toEqual({
      agentSessionId: "session-1",
      source: "agent-markdown",
      type: "open-agent-session",
      workspaceId: "workspace-1"
    });
    expect(
      resolveAgentConversationNavigationAction({
        href: "https://tutti.dev/docs",
        source: "agent-markdown"
      })
    ).toEqual({
      source: "agent-markdown",
      type: "open-url",
      url: "https://tutti.dev/docs"
    });
    expect(
      resolveAgentConversationNavigationAction({
        href: "./README.md",
        source: "agent-markdown"
      })
    ).toBeNull();
  });
});
