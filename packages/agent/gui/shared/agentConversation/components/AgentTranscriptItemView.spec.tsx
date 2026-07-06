import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getAgentEnvPanelStore } from "../../agentEnv/agentEnvPanelStore";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { AgentMessageBlock } from "./AgentMessageBlock";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import type { AgentMessageContentVM } from "../contracts/agentMessageRowVM";
import type { AgentMessageRowVM } from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentToolGroupRowVM } from "../contracts/agentToolGroupRowVM";

const mockState = vi.hoisted(() => ({
  markdownOnLinkClicks: [] as Array<((href: string) => void) | undefined>,
  markdownStreamingFlags: [] as Array<boolean | undefined>,
  toolGroupOnLinkClicks: [] as Array<((href: string) => void) | undefined>
}));

vi.mock("../../../i18n/index", () => ({
  getActiveUiLanguage: () => "en",
  useTranslation: () => ({
    t: (key: string) => key
  }),
  translate: (key: string) => key
}));

vi.mock("../../AgentMessageMarkdown", () => ({
  AgentMessageMarkdown: ({
    content,
    onLinkClick,
    streaming
  }: {
    content: string;
    onLinkClick?: (href: string) => void;
    streaming?: boolean;
  }) => {
    mockState.markdownOnLinkClicks.push(onLinkClick);
    mockState.markdownStreamingFlags.push(streaming);
    return <div>{content}</div>;
  }
}));

vi.mock("../../AgentRichTextReadonly", () => ({
  AgentRichTextReadonly: ({
    className,
    onLinkClick,
    value
  }: {
    className?: string;
    onLinkClick?: (href: string) => void;
    value?: string;
  }) => {
    mockState.markdownOnLinkClicks.push(onLinkClick);
    return <div className={className}>{value ?? "User message"}</div>;
  }
}));

vi.mock("./AgentToolGroupRow", () => ({
  AgentToolGroupRow: ({
    onLinkClick
  }: {
    onLinkClick?: (href: string) => void;
  }) => {
    mockState.toolGroupOnLinkClicks.push(onLinkClick);
    return <div>Tool group</div>;
  }
}));

describe("AgentTranscriptItemView render stability", () => {
  it("keeps tool link handlers stable when an unchanged tool row is reprojected", () => {
    const onLinkAction = vi.fn();
    const labels = transcriptLabels();
    const { rerender } = render(
      <AgentTranscriptItemView
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={toolGroupRow()}
        labels={labels}
        onLinkAction={onLinkAction}
      />
    );

    rerender(
      <AgentTranscriptItemView
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={toolGroupRow()}
        labels={labels}
        onLinkAction={onLinkAction}
      />
    );

    expect(mockState.toolGroupOnLinkClicks).toHaveLength(2);
    expect(mockState.toolGroupOnLinkClicks[1]).toBe(
      mockState.toolGroupOnLinkClicks[0]
    );
  });

  it("keeps assistant markdown link handlers stable when an unchanged message row is reprojected", () => {
    const onLinkAction = vi.fn();
    const { rerender } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow()}
        onLinkAction={onLinkAction}
        thinkingLabel="Thought process"
      />
    );

    rerender(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow()}
        onLinkAction={onLinkAction}
        thinkingLabel="Thought process"
      />
    );

    expect(mockState.markdownOnLinkClicks).toHaveLength(2);
    expect(mockState.markdownOnLinkClicks[1]).toBe(
      mockState.markdownOnLinkClicks[0]
    );
  });

  it("enables streaming markdown only for working assistant messages", () => {
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-working-1",
          turnId: "turn-1",
          body: "Streaming answer",
          statusKind: "working",
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-completed-1",
          turnId: "turn-1",
          body: "Completed answer",
          statusKind: "completed",
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(mockState.markdownStreamingFlags.at(-2)).toBe(true);
    expect(mockState.markdownStreamingFlags.at(-1)).toBe(false);
  });

  it("renders plain user messages inside a copyable message group", () => {
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow()}
        thinkingLabel="Thought process"
      />
    );

    const flow = document.querySelector(
      ".agent-gui-conversation__user-message-flow"
    );
    expect(flow).toBeInstanceOf(HTMLElement);
    expect(flow?.children).toHaveLength(1);
    const group = flow?.children.item(0);
    expect(group).toBeInstanceOf(HTMLElement);
    if (!(group instanceof HTMLElement)) {
      throw new Error("Expected user message group to render.");
    }
    const bubble = group.children.item(0);
    expect(bubble).toBeInstanceOf(HTMLElement);
    if (!(bubble instanceof HTMLElement)) {
      throw new Error("Expected user message bubble to render.");
    }
    expect(group).toHaveAttribute("data-agent-message-speaker", "user");
    expect(group).toHaveTextContent("User asks for a fix");
    expect(
      group.querySelector(".agent-gui-conversation__message-copy-button")
    ).toBeInstanceOf(HTMLButtonElement);
  });

  it("copies user message text through the agent host clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    installAgentHostClipboard(writeText);

    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow()}
        thinkingLabel="Thought process"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.copyMessage"
      })
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("User asks for a fix");
    });
    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.messageCopied"
      })
    ).toBeTruthy();
  });

  it("copies assistant markdown source through the agent host clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    installAgentHostClipboard(writeText);

    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-copy-1",
          turnId: "turn-1",
          body: "Assistant **summary** with `code`",
          copyText: "Assistant **summary** with `code`",
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.copyMessage"
      })
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Assistant **summary** with `code`"
      );
    });
  });

  it("loads user prompt image attachments from the activity runtime", async () => {
    const readSessionAttachment = vi.fn(async () => ({
      attachmentId: "attachment-1",
      data: "aW1hZ2U=",
      mimeType: "image/png" as const,
      name: "screen.png"
    }));
    Object.defineProperty(window, "agentActivityRuntime", {
      configurable: true,
      value: {
        readSessionAttachment
      } as Partial<AgentActivityRuntime>
    });

    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow({
          kind: "message-content",
          id: "user-images-1",
          turnId: "turn-1",
          body: "",
          contentKind: "image-grid",
          images: [
            {
              id: "attachment-1",
              workspaceId: "room-1",
              agentSessionId: "session-1",
              attachmentId: "attachment-1",
              mimeType: "image/png",
              name: "screen.png"
            }
          ],
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    await waitFor(() => {
      expect(readSessionAttachment).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        attachmentId: "attachment-1"
      });
    });
    await waitFor(() => {
      const image = screen.getByRole("img", { name: "screen.png" });
      expect(image).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
      expect(
        screen.getByRole("button", { name: "common.expandImage" })
      ).toBeTruthy();
    });

    delete (window as { agentActivityRuntime?: unknown }).agentActivityRuntime;
  });

  it("shows a loading spinner while a user prompt image is being read", async () => {
    const readController: {
      resolve: (value: {
        attachmentId: string;
        data: string;
        mimeType: "image/png";
        name: string;
      }) => void;
    } = {
      resolve: () => {
        throw new Error("readSessionAttachment was not called");
      }
    };
    const readSessionAttachment = vi.fn(
      () =>
        new Promise<{
          attachmentId: string;
          data: string;
          mimeType: "image/png";
          name: string;
        }>((resolvePromise) => {
          readController.resolve = resolvePromise;
        })
    );
    Object.defineProperty(window, "agentActivityRuntime", {
      configurable: true,
      value: {
        readSessionAttachment
      } as Partial<AgentActivityRuntime>
    });

    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow({
          kind: "message-content",
          id: "user-images-loading",
          turnId: "turn-1",
          body: "",
          contentKind: "image-grid",
          images: [
            {
              id: "attachment-loading",
              workspaceId: "room-1",
              agentSessionId: "session-1",
              attachmentId: "attachment-loading",
              mimeType: "image/png",
              name: "screen.png"
            }
          ],
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(
      await screen.findByTestId("agent-gui-message-image-loading")
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "screen.png" })).toBeNull();

    readController.resolve({
      attachmentId: "attachment-loading",
      data: "aW1hZ2U=",
      mimeType: "image/png",
      name: "screen.png"
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("agent-gui-message-image-loading")
      ).toBeNull();
      expect(screen.getByRole("img", { name: "screen.png" })).toHaveAttribute(
        "src",
        "data:image/png;base64,aW1hZ2U="
      );
    });

    delete (window as { agentActivityRuntime?: unknown }).agentActivityRuntime;
  });

  it("shows local agent sign-in guidance for auth errors", () => {
    getAgentEnvPanelStore().open = false;
    const { getByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow(claudeCodeAuthErrorMessage())}
        thinkingLabel="Thought process"
      />
    );

    expect(
      getByText("agentHost.agentGui.visibleErrorAuthRequired")
    ).toBeTruthy();
    expect(
      getByText("agentHost.agentGui.visibleErrorAuthRequiredLocalAgentHint")
    ).toBeTruthy();
    fireEvent.click(getByText("agentHost.agentGui.visibleErrorActionRelogin"));
    const store = getAgentEnvPanelStore();
    expect(store.open).toBe(true);
    expect(store.provider).toBe("claude-code");
    expect(store.focus).toBe("auth");
  });

  it("renders transport retry notice details without the generic title", () => {
    const { getByText, queryByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-notice-1",
          turnId: "turn-1",
          body: "Codex connection interrupted. Reconnecting...",
          occurredAtUnixMs: 1,
          systemNotice: {
            noticeKind: "transport_retry",
            severity: "warning",
            title: "Codex connection interrupted. Reconnecting...",
            detail:
              "Handled error during turn: Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: None })",
            retryable: true
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(getByText("Reconnecting... 1/5")).toBeTruthy();
    const notice = getByText("Reconnecting... 1/5");
    expect(notice.tagName).toBe("DIV");
    expect(queryByText("agentHost.agentGui.visibleErrorDetails")).toBeNull();
    expect(
      queryByText("Codex connection interrupted. Reconnecting...")
    ).toBeNull();
    expect(
      queryByText("agentHost.agentGui.systemNoticeTransportRetry")
    ).toBeNull();
  });

  it("renders transport fallback notices with the localized label", () => {
    const { getByRole, getByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-transport-fallback",
          turnId: "turn-1",
          body: "Falling back from WebSockets to HTTPS transport.",
          occurredAtUnixMs: 1,
          systemNotice: {
            noticeKind: "transport_fallback",
            severity: "warning",
            title: "Falling back from WebSockets to HTTPS transport.",
            detail:
              "stream disconnected before completion: websocket closed by server before response.completed",
            retryable: true
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(getByRole("status")).toBeTruthy();
    expect(
      getByText("agentHost.agentGui.systemNoticeTransportFallback")
    ).toBeTruthy();
  });

  it("renders fallback warning notices with their title", () => {
    const { getByRole, getByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-warning-fallback",
          turnId: "turn-1",
          body: "Falling back from WebSockets to HTTPS transport.",
          occurredAtUnixMs: 1,
          systemNotice: {
            noticeKind: "warning",
            severity: "warning",
            title: "Falling back from WebSockets to HTTPS transport.",
            detail:
              "stream disconnected before completion: websocket closed by server before response.completed",
            retryable: true
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(getByRole("status")).toBeTruthy();
    expect(
      getByText("Falling back from WebSockets to HTTPS transport.")
    ).toBeTruthy();
  });

  it("renders context compaction notices as an inline divider", () => {
    const { getByRole, getByText, queryByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-notice-compaction",
          turnId: "turn-1",
          body: "Context compacted.",
          occurredAtUnixMs: 1,
          systemNotice: {
            noticeKind: "system_notice",
            severity: null,
            title: "Context compacted.",
            detail: "",
            retryable: null
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    const notice = getByRole("status");
    expect(notice.tagName).toBe("DIV");
    const dividers = notice.querySelectorAll('span[aria-hidden="true"]');
    expect(dividers).toHaveLength(2);
    expect(
      getByText("agentHost.agentGui.contextCompactionCompleted")
    ).toBeTruthy();
    expect(queryByText("agentHost.agentGui.systemNoticeDefault")).toBeNull();
  });

  it("renders in-progress compaction notices as a divider with a ticking timer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(66_000);
      const { getByRole, getByText } = render(
        <AgentMessageBlock
          workspaceRoot="/workspace/demo"
          basePath="/workspace/demo"
          row={assistantMessageRow({
            kind: "message-content",
            id: "assistant-notice-compacting",
            turnId: "turn-1",
            body: "Compacting context.",
            occurredAtUnixMs: 61_000,
            systemNotice: {
              noticeKind: "system_notice",
              severity: null,
              title: "Compacting context.",
              detail: "",
              retryable: null
            }
          })}
          thinkingLabel="Thought process"
        />
      );

      const notice = getByRole("status");
      const dividers = notice.querySelectorAll('span[aria-hidden="true"]');
      expect(dividers).toHaveLength(2);
      expect(
        getByText(/agentHost\.agentGui\.contextCompactionInProgress/)
      ).toBeTruthy();
      expect(getByText(/· 5s/)).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(getByText(/· 8s/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders interrupted compaction notices as a static divider", () => {
    const { getByRole, getByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-notice-compaction-interrupted",
          turnId: "turn-1",
          body: "Context compaction interrupted.",
          occurredAtUnixMs: 1,
          systemNotice: {
            noticeKind: "system_notice",
            severity: null,
            title: "Context compaction interrupted.",
            detail: "",
            retryable: null
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    const notice = getByRole("status");
    expect(notice.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
    expect(
      getByText("agentHost.agentGui.contextCompactionInterrupted")
    ).toBeTruthy();
  });

  it("renders plan-tagged assistant messages as a dedicated plan card", () => {
    const { getByTestId } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-plan-1",
          turnId: "turn-1",
          body: "# Repo health plan\n1. inspect\n2. fix",
          contentKind: "plan",
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(getByTestId("agent-plan-card")).toBeTruthy();
    expect(getByTestId("agent-plan-card-title").textContent).toBe(
      "agentHost.agentGui.planCardTitle"
    );
    expect(getByTestId("agent-plan-card").textContent).toContain(
      "Repo health plan"
    );
  });
});

function transcriptLabels() {
  return {
    thinkingLabel: "Thought process",
    toolCallsLabel: (count: number) => `Tool calls (${count})`,
    processing: "Planning next moves",
    turnSummary: "Changed files"
  };
}

function assistantMessageRow(
  message: AgentMessageContentVM = {
    kind: "message-content",
    id: "assistant-1",
    turnId: "turn-1",
    body: "Assistant answer with [README](/workspace/demo/README.md)",
    occurredAtUnixMs: 1
  }
): AgentMessageRowVM {
  return {
    kind: "message",
    id: "message-row-1",
    turnId: "turn-1",
    speaker: "assistant",
    messages: [message],
    thinking: [],
    occurredAtUnixMs: 1
  };
}

function userMessageRow(message?: AgentMessageContentVM): AgentMessageRowVM {
  return {
    kind: "message",
    id: "message-row-user-1",
    turnId: "turn-1",
    speaker: "user",
    messages: [
      message ?? {
        kind: "message-content",
        id: "user-1",
        turnId: "turn-1",
        body: "User asks for a fix",
        copyText: "User asks for a fix",
        occurredAtUnixMs: 1
      }
    ],
    thinking: [],
    occurredAtUnixMs: 1
  };
}

function installAgentHostClipboard(
  writeText: (text: string) => Promise<void>
): void {
  (
    window as unknown as {
      agentHostApi?: unknown;
    }
  ).agentHostApi = {
    agentGuiBatch: {},
    clipboard: { writeText },
    filesystem: {},
    workspace: {}
  };
}

function claudeCodeAuthErrorMessage(): AgentMessageContentVM {
  return {
    kind: "message-content",
    id: "assistant-auth-1",
    turnId: "turn-1",
    body: "Claude Code needs authentication.",
    occurredAtUnixMs: 1,
    visibleError: {
      code: "auth_required",
      phase: "start",
      provider: "claude-code",
      detail: "Failed to authenticate.",
      retryable: false
    }
  };
}

function toolGroupRow(): AgentToolGroupRowVM {
  const call = toolCall();
  return {
    kind: "tool-group",
    id: "tools-1",
    turnId: "turn-1",
    grouped: false,
    calls: [call],
    entries: [
      {
        kind: "tool-call",
        call
      }
    ],
    occurredAtUnixMs: 1
  };
}

function toolCall(): AgentToolCallVM {
  return {
    kind: "tool-call",
    id: "call-1",
    turnId: "turn-1",
    name: "Read File",
    toolName: "read_file",
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "/workspace/demo/README.md",
    compactSummary: "/workspace/demo/README.md",
    payload: null,
    toolState: null,
    input: null,
    output: null,
    error: null,
    metadata: null,
    content: null,
    locations: null,
    rendererKind: "read",
    approval: null,
    planMode: null,
    askUserQuestion: null,
    task: null,
    occurredAtUnixMs: 1
  };
}
