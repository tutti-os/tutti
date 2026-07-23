import { describe, expect, it } from "vitest";
import {
  createAgentSessionEngine,
  type AgentActivityMessage
} from "@tutti-os/agent-activity-core";
import {
  resolveAgentGuiWorkbenchConversationIdentity,
  resolveAgentGuiWorkbenchTitleDisplayPrompt
} from "./conversationIdentity.ts";

describe("resolveAgentGuiWorkbenchTitleDisplayPrompt", () => {
  it("projects browser elements into plain @ text", () => {
    const prompt =
      "[@<a>](mention://browser-element/browser-element%3A1?path=%2Ftmp%2Fa.txt&tag=a&workspaceId=workspace-1) 这里说的什么";

    expect(
      resolveAgentGuiWorkbenchTitleDisplayPrompt({
        messages: [userMessage(prompt)],
        title: "@<a> 这里说的什么"
      })
    ).toBe("@<a> 这里说的什么");
  });

  it("keeps only conversation text in the workbench title", () => {
    const prompt =
      "[@img](mention://browser-element/browser-element%3A1?tag=img&workspaceId=workspace-1) 这张图片打出来给我看看";
    const engine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: { execute: async () => ({}) },
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    engine.dispatch({
      type: "session/snapshotReceived",
      sessions: [
        {
          activeTurnId: null,
          agentSessionId: "session-1",
          createdAtUnixMs: 1,
          cwd: "/workspace",
          latestTurnInteractions: [],
          pendingInteractions: [],
          provider: "codex",
          title: "@img 这张图片打出来给我看看",
          updatedAtUnixMs: 1,
          workspaceId: "workspace-1"
        }
      ]
    });
    engine.dispatch({
      type: "message/snapshotReceived",
      messages: [userMessage(prompt)]
    });

    expect(
      resolveAgentGuiWorkbenchConversationIdentity({
        agents: [],
        engineState: engine.getSnapshot(),
        workbenchState: {
          lastActiveAgentSessionId: "session-1"
        }
      })
    ).toEqual(
      expect.objectContaining({
        title: "这张图片打出来给我看看",
        titleDisplayPrompt: "@img 这张图片打出来给我看看"
      })
    );
  });

  it("normalizes an issue mention when the title was derived from it", () => {
    const prompt =
      "[@Task](mention://workspace-issue/issue-1?workspaceId=workspace-1) 看看";

    expect(
      resolveAgentGuiWorkbenchTitleDisplayPrompt({
        messages: [userMessage(prompt)],
        title: "@Task 看看"
      })
    ).toBe("@Task 看看");
  });

  it("does not replace an explicitly renamed title with the first prompt", () => {
    const prompt =
      "[@a](mention://browser-element/browser-element%3A1?path=%2Ftmp%2Fa.txt&tag=a&workspaceId=workspace-1) 这里说的什么";

    expect(
      resolveAgentGuiWorkbenchTitleDisplayPrompt({
        messages: [userMessage(prompt)],
        title: "Google 登录链接"
      })
    ).toBeNull();
  });

  it("does not restore a rich prompt after the canonical title was explicitly cleared", () => {
    const prompt =
      "[@a](mention://browser-element/browser-element%3A1?path=%2Ftmp%2Fa.txt&tag=a&workspaceId=workspace-1) 这里说的什么";

    expect(
      resolveAgentGuiWorkbenchTitleDisplayPrompt({
        messages: [userMessage(prompt)],
        title: null
      })
    ).toBeNull();
  });

  it("does not replace ordinary plain-text titles", () => {
    expect(
      resolveAgentGuiWorkbenchTitleDisplayPrompt({
        messages: [userMessage("这里说的什么")],
        title: "这里说的什么"
      })
    ).toBeNull();
  });
});

function userMessage(prompt: string): AgentActivityMessage {
  return {
    agentSessionId: "session-1",
    messageId: "user-1",
    version: 1,
    turnId: "turn-1",
    role: "user",
    kind: "text",
    payload: {
      content: [{ type: "text", text: prompt }],
      text: prompt
    },
    occurredAtUnixMs: 1
  };
}
