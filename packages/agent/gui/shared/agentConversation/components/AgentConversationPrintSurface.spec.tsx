import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { AgentConversationPrintSurface } from "./AgentConversationPrintSurface";

describe("AgentConversationPrintSurface", () => {
  it("portals the native conversation layout and reports when it is ready", async () => {
    const onReady = vi.fn();
    const rendered = render(
      <AgentConversationPrintSurface
        conversation={conversation()}
        expandedToolRowKeys={new Set()}
        labels={{
          thinkingLabel: "Thought process",
          toolCallsLabel: (count) => `Tool calls (${count})`,
          processing: "Processing",
          turnSummary: "Changed files"
        }}
        onReady={onReady}
        requestId={7}
        turnExpandedOverrides={{}}
      />
    );

    const surface = document.body.querySelector(
      '[data-agent-conversation-print-surface="true"]'
    );
    expect(surface).toBeInstanceOf(HTMLElement);
    expect(
      surface?.querySelector(".agent-gui-conversation__user-message-flow")
    ).toBeInstanceOf(HTMLElement);
    expect(
      surface?.querySelector(".agent-gui-conversation__assistant-message-flow")
    ).toBeInstanceOf(HTMLElement);
    expect(
      surface?.querySelectorAll(".agent-gui-conversation__message-timestamp")
    ).toHaveLength(2);
    expect(surface?.querySelector(".agent-gui-message-locator")).toBeNull();
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(7));

    rendered.unmount();
    expect(
      document.body.querySelector(
        '[data-agent-conversation-print-surface="true"]'
      )
    ).toBeNull();
  });
});

function conversation(): AgentConversationVM {
  return {
    activity: {
      id: "activity-1",
      sessionId: "session-1",
      agentName: "Codex",
      agentProvider: "codex",
      title: "Build repair",
      latestActivitySummary: "Done",
      status: "idle",
      sortTimeUnixMs: 10,
      changedFiles: [],
      userId: "user-1",
      userName: "Taylor",
      userAvatarUrl: ""
    },
    workspaceRoot: "/workspace",
    sourceDetail: {
      activity: {} as AgentConversationVM["sourceDetail"]["activity"],
      session: {
        agentSessionId: "session-1",
        activeTurnId: null
      } as AgentConversationVM["sourceDetail"]["session"],
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      turns: []
    },
    rows: [
      messageRow("user-1", "user", "Fix the build"),
      messageRow("assistant-1", "assistant", "Done")
    ]
  };
}

function messageRow(
  id: string,
  speaker: "user" | "assistant",
  body: string
): AgentConversationVM["rows"][number] {
  return {
    kind: "message",
    id,
    turnId: "turn-1",
    speaker,
    messages: [
      {
        kind: "message-content",
        id: `${id}-content`,
        turnId: "turn-1",
        body,
        copyText: speaker === "user" ? body : null,
        presentationKind: "content",
        occurredAtUnixMs: 1
      }
    ],
    thinking: [],
    occurredAtUnixMs: 1
  };
}
