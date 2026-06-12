import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { AgentMessageBlock } from "./AgentMessageBlock";
import { AgentTranscriptItemView } from "./AgentTranscriptItemView";
import type { AgentMessageContentVM } from "../contracts/agentMessageRowVM";
import type { AgentMessageRowVM } from "../contracts/agentMessageRowVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentToolGroupRowVM } from "../contracts/agentToolGroupRowVM";

const mockState = vi.hoisted(() => ({
  markdownOnLinkClicks: [] as Array<((href: string) => void) | undefined>,
  toolGroupOnLinkClicks: [] as Array<((href: string) => void) | undefined>
}));

vi.mock("../../../i18n/index", () => ({
  useTranslation: () => ({
    t: (key: string) => key
  }),
  translate: (key: string) => key
}));

vi.mock("../../AgentMessageMarkdown", () => ({
  AgentMessageMarkdown: ({
    content,
    onLinkClick
  }: {
    content: string;
    onLinkClick?: (href: string) => void;
  }) => {
    mockState.markdownOnLinkClicks.push(onLinkClick);
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

  it("renders plain user messages as direct flow children without an extra group", () => {
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
    expect(flow?.children[0]).toHaveClass(
      "workspace-agents-status-panel__detail-user-message",
      "agent-gui-conversation__user-message-bubble"
    );
    expect(flow?.children[0]).toHaveTextContent("User asks for a fix");
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
      expect(image).toHaveClass("cursor-zoom-in", "size-full", "object-cover");
      const imageBlock = image.closest(".size-20");
      expect(imageBlock).toBeInstanceOf(HTMLElement);
      expect(imageBlock).toHaveClass("size-20", "overflow-hidden");
      const imageGrid = imageBlock?.parentElement;
      expect(imageGrid).toHaveClass("grid", "justify-self-end");
      expect(imageGrid).toHaveStyle({
        gridTemplateColumns: "repeat(1, 80px)"
      });
      const imageGridClasses = imageGrid?.className.split(/\s+/) ?? [];
      expect(
        imageGridClasses.some((className) => className.startsWith("bg-"))
      ).toBe(false);
      expect(
        imageGridClasses.some((className) => className.startsWith("shadow"))
      ).toBe(false);
      expect(imageGridClasses).not.toContain("p-2");
      expect(
        screen.getByRole("button", { name: "common.expandImage" })
      ).toBeTruthy();
    });

    delete (window as { agentActivityRuntime?: unknown }).agentActivityRuntime;
  });

  it("keeps assistant conversation markdown on the carried TSH reading scale", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s*{[^}]*font-size:\s*15px[^}]*line-height:\s*1\.72/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-markdown\.agent-gui-conversation__assistant-markdown\s+p\s*{[^}]*margin:\s*0[^}]*}/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-markdown\.agent-gui-conversation__assistant-markdown\s+hr\s*{[^}]*height:\s*1px[^}]*margin:\s*14px 0[^}]*border:\s*0[^}]*background:\s*var\(--line-2,\s*var\(--nextop-line-2\)\)/s
    );
    expect(css).not.toMatch(
      /\.workspace-agents-status-panel__detail-markdown\.agent-gui-conversation__assistant-markdown\s+:is\(h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6,\s*ul,\s*ol,\s*li\)\s*{[^}]*font-size:\s*14px/s
    );
  });

  it("keeps flat tool content visually embedded in the conversation flow", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-body--flat\s*{[^}]*border:\s*1px solid var\(--hairline-strong\)[^}]*border-radius:\s*6px[^}]*overflow:\s*hidden/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-code--flat,[\s\S]*?\.workspace-agents-status-panel__detail-tool-diff--flat,[\s\S]*?\.workspace-agents-status-panel__detail-tool-monaco--flat\s*{[^}]*box-shadow:\s*none[^}]*border:\s*0[^}]*border-radius:\s*0/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-diff-added\s*{[^}]*color:\s*var\(--state-success\)/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-diff-removed\s*{[^}]*color:\s*var\(--state-danger\)/s
    );
  });

  it("shows local agent sign-in guidance for auth errors", () => {
    const onAuthLogin = vi.fn();
    const { getByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/workspace/demo"
        row={assistantMessageRow(claudeCodeAuthErrorMessage())}
        onAuthLogin={onAuthLogin}
        thinkingLabel="Thought process"
      />
    );

    expect(
      getByText("agentHost.agentGui.visibleErrorAuthRequired")
    ).toBeTruthy();
    expect(
      getByText("agentHost.agentGui.visibleErrorAuthRequiredLocalAgentHint")
    ).toBeTruthy();
    fireEvent.click(getByText("agentHost.agentGui.authLogin"));
    expect(onAuthLogin).toHaveBeenCalledWith("claude-code");
  });

  it("shows transport retry notices separately from markdown answers", () => {
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
              "ResponseStreamDisconnected: websocket IO error: Broken pipe",
            retryable: true
          }
        })}
        thinkingLabel="Thought process"
      />
    );

    expect(
      getByText("agentHost.agentGui.systemNoticeTransportRetry")
    ).toBeTruthy();
    expect(getByText("agentHost.agentGui.visibleErrorDetails")).toBeTruthy();
    expect(
      queryByText("Codex connection interrupted. Reconnecting...")
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
        occurredAtUnixMs: 1
      }
    ],
    thinking: [],
    occurredAtUnixMs: 1
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
