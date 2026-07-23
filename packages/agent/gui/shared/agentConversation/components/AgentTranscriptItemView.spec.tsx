import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEnvPanelActionProvider } from "../../agentEnv";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { AgentMessageBlock } from "./AgentMessageBlock";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import type { AgentGeneratedImageRowVM } from "../contracts/agentGeneratedImageRowVM";
import type { AgentGoalControlRowVM } from "../contracts/agentGoalControlRowVM";
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

beforeEach(() => {
  mockState.markdownOnLinkClicks.length = 0;
  mockState.markdownStreamingFlags.length = 0;
  mockState.toolGroupOnLinkClicks.length = 0;
});

describe("AgentTranscriptItemView render stability", () => {
  it("renders a goal control as a dedicated transcript row", () => {
    const row: AgentGoalControlRowVM = {
      kind: "goal-control",
      id: "goal-control:client-submit:user:submit-goal-1",
      turnId: null,
      action: "set",
      body: "/goal ship it",
      occurredAtUnixMs: 1
    };

    const { container } = render(
      <AgentTranscriptItemView
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={row}
        labels={transcriptLabels()}
      />
    );

    expect(screen.getByText("/goal ship it")).toBeInTheDocument();
    expect(
      container.querySelector('[data-agent-goal-control-action="set"]')
    ).toBeInTheDocument();
  });

  it("renders a generated image artifact independently from tool-call expansion", () => {
    const row: AgentGeneratedImageRowVM = {
      kind: "generated-image",
      id: "generated-image:call:image-1",
      turnId: "turn-1",
      sourceCallId: "call:image-1",
      uri: "data:image/png;base64,aW1hZ2U=",
      mimeType: "image/png",
      prompt: "A friendly corgi",
      occurredAtUnixMs: 1
    };

    render(
      <AgentTranscriptItemView
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={row}
        labels={transcriptLabels()}
      />
    );

    expect(
      screen.getByTestId("agent-generated-image-artifact")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "agentHost.agentTool.details.imagePreviewAlt"
      })
    ).toHaveAttribute("src", row.uri);
  });

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

  it("routes a clicked app artifact reference from a sent user message to the owning app", () => {
    const onLinkAction = vi.fn();
    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow({
          kind: "message-content",
          id: "user-app-reference-1",
          turnId: "turn-1",
          body: "[@AI Canvas](mention://workspace-reference/ai-canvas?source=app&workspaceId=workspace-1)",
          occurredAtUnixMs: 1
        })}
        onLinkAction={onLinkAction}
        thinkingLabel="Thought process"
      />
    );

    mockState.markdownOnLinkClicks.at(-1)?.(
      "mention://workspace-reference/ai-canvas?source=app&workspaceId=workspace-1"
    );

    expect(onLinkAction).toHaveBeenCalledWith({
      type: "open-workspace-app",
      workspaceId: "workspace-1",
      appId: "ai-canvas",
      source: "agent-markdown"
    });
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
    expect(group).toHaveAttribute("data-agent-message-footer", "true");
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

  it("keeps a loaded optimistic image mounted when its durable attachment arrives", async () => {
    const readPromptAsset = vi.fn(async () => ({
      attachmentId: "prompt-asset-1",
      data: "b3B0aW1pc3RpYw==",
      mimeType: "image/png" as const,
      name: "screen.png",
      path: "/prompt-assets/screen.png"
    }));
    const readSessionAttachment = vi.fn(async () => ({
      attachmentId: "attachment-1",
      data: "ZHVyYWJsZQ==",
      mimeType: "image/png" as const,
      name: "screen.png"
    }));
    Object.defineProperty(window, "agentActivityRuntime", {
      configurable: true,
      value: {
        readPromptAsset,
        readSessionAttachment
      } as Partial<AgentActivityRuntime>
    });
    const stableImageId = "client-submit:user:submit-1:image:0";
    const optimisticMessage: AgentMessageContentVM = {
      kind: "message-content",
      id: "client-submit:user:submit-1:images:0",
      turnId: "turn-1",
      body: "",
      presentationKind: "content",
      contentKind: "image-grid",
      images: [
        {
          id: stableImageId,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          mimeType: "image/png",
          name: "screen.png",
          path: "/prompt-assets/screen.png"
        }
      ],
      occurredAtUnixMs: 1
    };
    const durableMessage: AgentMessageContentVM = {
      ...optimisticMessage,
      images: [
        {
          id: stableImageId,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          attachmentId: "attachment-1",
          mimeType: "image/png",
          name: "screen.png"
        }
      ],
      occurredAtUnixMs: 2
    };
    const { rerender } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow(optimisticMessage)}
        thinkingLabel="Thought process"
      />
    );

    const optimisticImage = await screen.findByRole("img", {
      name: "screen.png"
    });
    expect(optimisticImage).toHaveAttribute(
      "src",
      "data:image/png;base64,b3B0aW1pc3RpYw=="
    );

    rerender(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow(durableMessage)}
        thinkingLabel="Thought process"
      />
    );

    expect(screen.getByRole("img", { name: "screen.png" })).toBe(
      optimisticImage
    );
    expect(screen.queryByTestId("agent-gui-message-image-loading")).toBeNull();
    expect(readPromptAsset).toHaveBeenCalledTimes(1);
    expect(readSessionAttachment).not.toHaveBeenCalled();

    delete (window as { agentActivityRuntime?: unknown }).agentActivityRuntime;
  });

  it("renders a user prompt image directly from its remote HTTPS URL", () => {
    const readPromptAsset = vi.fn();
    Object.defineProperty(window, "agentActivityRuntime", {
      configurable: true,
      value: {
        readPromptAsset
      } as Partial<AgentActivityRuntime>
    });

    render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={userMessageRow({
          kind: "message-content",
          id: "user-images-url-1",
          turnId: "turn-1",
          body: "",
          contentKind: "image-grid",
          images: [
            {
              id: "remote-image-1",
              workspaceId: "room-1",
              agentSessionId: "session-1",
              mimeType: "image/png",
              name: "screen.png",
              url: "https://objects.example.test/signed/screen.png"
            }
          ],
          occurredAtUnixMs: 1
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(screen.getByRole("img", { name: "screen.png" })).toHaveAttribute(
      "src",
      "https://objects.example.test/signed/screen.png"
    );
    expect(readPromptAsset).not.toHaveBeenCalled();

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
    const onOpenAgentEnvPanel = vi.fn();
    const { getByText } = render(
      <AgentEnvPanelActionProvider openPanel={onOpenAgentEnvPanel}>
        <AgentMessageBlock
          workspaceRoot="/workspace/demo"
          basePath="/workspace/demo"
          row={assistantMessageRow(claudeCodeAuthErrorMessage())}
          thinkingLabel="Thought process"
        />
      </AgentEnvPanelActionProvider>
    );

    expect(
      getByText("agentHost.agentGui.visibleErrorAuthRequired")
    ).toBeTruthy();
    expect(
      getByText("agentHost.agentGui.visibleErrorAuthRequiredLocalAgentHint")
    ).toBeTruthy();
    fireEvent.click(getByText("agentHost.agentGui.visibleErrorActionRelogin"));
    expect(onOpenAgentEnvPanel).toHaveBeenCalledWith({
      provider: "claude-code",
      focus: "auth"
    });
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

  it.each([
    [
      "plan_implementation_pending_confirmation",
      "agentHost.agentGui.systemNoticePlanImplementationPendingConfirmation"
    ],
    [
      "plan_implementation_completed",
      "agentHost.agentGui.systemNoticePlanImplementationCompleted"
    ]
  ])(
    "renders semantic plan notice %s without transport text",
    (noticeKind, key) => {
      const { getByText } = render(
        <AgentMessageBlock
          workspaceRoot="/workspace/demo"
          basePath="/workspace/demo"
          row={assistantMessageRow({
            kind: "message-content",
            id: `assistant-${noticeKind}`,
            turnId: "turn-1",
            body: "",
            occurredAtUnixMs: 1,
            systemNotice: {
              noticeKind,
              severity: "info",
              title: null,
              detail: null,
              retryable: false
            }
          })}
          thinkingLabel="Thought process"
        />
      );
      expect(getByText(key)).toBeTruthy();
    }
  );

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
            command: "compact",
            commandStatus: "completed",
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
              command: "compact",
              commandStatus: "running",
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

  it("renders interrupted compaction notices with a wrapping detail below the divider", () => {
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
            command: "compact",
            commandStatus: "failed",
            title: "Provider compact failure",
            detail: "Not enough messages to compact.",
            retryable: null
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    const notice = getByRole("status");
    expect(notice.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(2);
    expect(notice.textContent).toContain(
      "agentHost.agentGui.contextCompactionInterrupted"
    );
    expect(notice.textContent).toContain("Not enough messages to compact.");
    const detail = getByText("Not enough messages to compact.");
    expect(detail.className).toContain("break-words");
    expect(detail.className).not.toContain("whitespace-nowrap");
  });

  it("does not let a legacy title override canonical compact status", () => {
    const { getByText, queryByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow({
          kind: "message-content",
          id: "assistant-notice-conflicting-compaction",
          turnId: "turn-1",
          body: "Context compacted.",
          occurredAtUnixMs: 1,
          systemNotice: {
            noticeKind: "system_notice",
            severity: null,
            command: "compact",
            commandStatus: "failed",
            title: "Context compacted.",
            detail: "",
            retryable: null
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(
      getByText("agentHost.agentGui.contextCompactionInterrupted")
    ).toBeTruthy();
    expect(
      queryByText("agentHost.agentGui.contextCompactionCompleted")
    ).toBeNull();
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

type TestAgentMessageContentVM = Omit<
  AgentMessageContentVM,
  "presentationKind"
> & {
  presentationKind?: AgentMessageContentVM["presentationKind"];
};

function assistantMessageRow(
  message: TestAgentMessageContentVM = {
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
    messages: [withDefaultPresentationKind(message)],
    thinking: [],
    occurredAtUnixMs: 1
  };
}

function userMessageRow(
  message?: TestAgentMessageContentVM
): AgentMessageRowVM {
  return {
    kind: "message",
    id: "message-row-user-1",
    turnId: "turn-1",
    speaker: "user",
    messages: [
      withDefaultPresentationKind(
        message ?? {
          kind: "message-content",
          id: "user-1",
          turnId: "turn-1",
          body: "User asks for a fix",
          copyText: "User asks for a fix",
          occurredAtUnixMs: 1
        }
      )
    ],
    thinking: [],
    occurredAtUnixMs: 1
  };
}

function withDefaultPresentationKind(
  message: TestAgentMessageContentVM
): AgentMessageContentVM {
  return {
    ...message,
    presentationKind: message.presentationKind ?? "content"
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
    presentationKind: "content",
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
