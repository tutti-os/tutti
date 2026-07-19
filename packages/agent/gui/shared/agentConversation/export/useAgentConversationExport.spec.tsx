import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationVM } from "../contracts/agentConversationVM";
import { useAgentConversationExport } from "./useAgentConversationExport";

vi.mock("../../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.index ? `${key}:${String(options.index)}` : key
  })
}));

describe("useAgentConversationExport", () => {
  afterEach(() => {
    delete (window as unknown as { agentHostApi?: unknown }).agentHostApi;
  });

  it("waits for the native print surface before asking the host to save PDF", async () => {
    const save = vi.fn(async () => ({ status: "canceled" as const }));
    (window as unknown as { agentHostApi?: unknown }).agentHostApi = {
      clipboard: { writeText: async () => undefined },
      conversationExport: { save },
      filesystem: {},
      workspace: {}
    };
    const turnExpandedOverrides = { "session-1:turn-1": true };
    const rendered = renderHook(() =>
      useAgentConversationExport({
        conversation: completedConversation(),
        previewMode: false,
        toolCallsLabel: (count) => `Tool calls (${count})`,
        turnExpandedOverrides
      })
    );

    act(() => rendered.result.current.selection?.onToggleTurn("turn-1"));
    act(() =>
      rendered.result.current.onToolGroupExpandedChange("tools-1", true)
    );
    let exportPromise: Promise<void> | null = null;
    act(() => {
      exportPromise = rendered.result.current.exportConversation("pdf");
    });

    await waitFor(() => {
      expect(rendered.result.current.printRequest).not.toBeNull();
    });
    expect(save).not.toHaveBeenCalled();
    expect(
      rendered.result.current.printRequest?.expandedToolRowKeys.has("tools-1")
    ).toBe(true);
    expect(rendered.result.current.printRequest?.turnExpandedOverrides).toEqual(
      turnExpandedOverrides
    );

    act(() => {
      const requestId = rendered.result.current.printRequest?.requestId;
      if (requestId) rendered.result.current.onPrintSurfaceReady(requestId);
    });
    await act(async () => {
      await exportPromise;
    });

    expect(save).toHaveBeenCalledWith({
      format: "pdf",
      renderSource: "current-renderer",
      suggestedFileName: expect.stringMatching(/_Fix th_sessio\.pdf$/)
    });
    expect(rendered.result.current.printRequest).toBeNull();
  });
});

function completedConversation(): AgentConversationVM {
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
        copyText: body,
        presentationKind: "content",
        occurredAtUnixMs: 1
      }
    ],
    thinking: [],
    occurredAtUnixMs: 1
  };
}
