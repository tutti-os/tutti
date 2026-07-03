import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(group).toHaveClass("agent-gui-conversation__message-group");
    expect(group).toHaveAttribute("data-agent-message-speaker", "user");
    expect(bubble).toHaveClass(
      "workspace-agents-status-panel__detail-user-message",
      "agent-gui-conversation__user-message-bubble"
    );
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

  it("shows the message copy action when hovering the bottom action row", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__message-group::after\s*{[^}]*top:\s*100%[^}]*right:\s*0[^}]*left:\s*0[^}]*height:\s*26px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__message-group:has\(\s*> \.agent-gui-conversation__message-footer\s*\)\s*{[^}]*margin-bottom:\s*26px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__message-group:hover[\s\S]*?> \.agent-gui-conversation__message-footer,[\s\S]*?\.agent-gui-conversation__message-group:focus-within[\s\S]*?> \.agent-gui-conversation__message-footer\s*{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-conversation__message-group::after\s*{[^}]*height:\s*10px/s
    );
  });

  it("keeps the message copy button compact within the action row", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__message-footer\s*{[^}]*top:\s*calc\(100% \+ 4px\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__message-copy-button\s*{[^}]*position:\s*static[^}]*width:\s*22px[^}]*min-width:\s*22px[^}]*height:\s*22px[^}]*min-height:\s*22px[^}]*border-radius:\s*5px/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-conversation__message-copy-button\s*{[^}]*width:\s*28px/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-conversation__message-copy-button\s*{[^}]*top:\s*calc\(100% \+ 8px\)/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-conversation__message-group:has\(\s*> \.agent-gui-conversation__message-footer\s*\)\s*{[^}]*margin-bottom:\s*36px/s
    );
  });

  it("keeps pasted prompt images separated from the message bubble", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__user-message-flow\s*{[^}]*row-gap:\s*14px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__user-image-grid\s*{[^}]*justify-self:\s*end/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__user-image-thumbnail\s*{[^}]*border:\s*1px solid var\(--line-2\)[^}]*border-radius:\s*8px/s
    );
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
      expect(image).toHaveClass("cursor-zoom-in", "max-h-20", "object-contain");
      const imageBlock = image.closest("div");
      expect(imageBlock).toBeInstanceOf(HTMLElement);
      expect(imageBlock).toHaveClass(
        "agent-gui-conversation__user-image-thumbnail"
      );
      const imageGrid = imageBlock?.parentElement;
      expect(imageGrid).toHaveClass("agent-gui-conversation__user-image-grid");
      expect(imageGrid).toHaveStyle({
        gridTemplateColumns: "repeat(1, 160px)"
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

  it("keeps assistant conversation markdown on the compact reading scale", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__assistant-markdown\s*{[^}]*font-size:\s*13px[^}]*line-height:\s*1\.72/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-markdown\.agent-gui-conversation__assistant-markdown\s+p\s*{[^}]*margin:\s*0[^}]*}/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-markdown\.agent-gui-conversation__assistant-markdown\s+hr\s*{[^}]*height:\s*1px[^}]*margin:\s*14px 0[^}]*border:\s*0[^}]*background:\s*var\(--line-2,\s*var\(--tutti-line-2\)\)/s
    );
    expect(css).not.toMatch(
      /\.workspace-agents-status-panel__detail-markdown\.agent-gui-conversation__assistant-markdown\s+:is\(h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6,\s*ul,\s*ol,\s*li\)\s*{[^}]*font-size:\s*\d+(?:\.\d+)?px/s
    );
  });

  it("keeps conversation flow secondary text on the 13px compact scale", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const messageBlockSource = readFileSync(
      resolve("shared/agentConversation/components/AgentMessageBlock.tsx"),
      "utf8"
    );
    const markdownSource = readFileSync(
      resolve("shared/AgentMessageMarkdown.tsx"),
      "utf8"
    );
    const thinkingDisclosureSource = readFileSync(
      resolve("shared/WorkspaceAgentSessionThinkingDisclosure.tsx"),
      "utf8"
    );
    const toolRendererSource = readFileSync(
      resolve(
        "shared/agentConversation/components/tool-renderers/code/AgentCodeBlock.tsx"
      ),
      "utf8"
    );

    expect(markdownSource).toContain("text-[13px]");
    expect(markdownSource).toContain("max-h-[calc(13px*1.5*8)]");
    expect(markdownSource).toContain("[&_code]:text-[11px]");
    expect(thinkingDisclosureSource).toContain("text-[13px]");
    expect(thinkingDisclosureSource).toContain("text-[11px]");
    expect(toolRendererSource).toContain("text-[11px]");
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-count\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-row\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-question\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-user-message\.agent-gui-conversation__user-message-bubble\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__message-copy-button\s*{[^}]*position:\s*static[^}]*opacity:\s*0/s
    );
    expect(messageBlockSource).toContain("CanvasNodeGhostIconButton");
    expect(css).toMatch(
      /\.agent-gui-conversation__message-group:hover[\s\S]*?\.agent-gui-conversation__message-copy-button,[\s\S]*?\.agent-gui-conversation__message-group:focus-within[\s\S]*?\.agent-gui-conversation__message-copy-button\s*{[^}]*opacity:\s*1/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-conversation__message-copy-button:hover\s*{/
    );
    expect(css).toMatch(
      /\.tsh-agent-object-token--file\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.tsh-agent-object-token--entity\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__message-bubble\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-body\s*{[^}]*font-size:\s*11px/s
    );
    expect(css).toMatch(
      /\.workspace-agents-status-panel__detail-tool-markdown\s*{[^}]*font-size:\s*11px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-option-description\s*{[^}]*font-size:\s*11px/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-actions button\s*{[^}]*font-size:\s*11px/s
    );
    expect(css).toMatch(
      /\.tsh-agent-object-token__kind\s*{[^}]*font-size:\s*11px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__row-meta\s*{[^}]*font-size:\s*11px/s
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
    expect(css).toMatch(
      /\.agent-turn-summary-card__path-directory\s*{[^}]*flex:\s*0 1 auto/s
    );
    expect(css).toMatch(
      /\.agent-turn-summary-card__path-file\s*{[^}]*flex:\s*0 0 auto[^}]*max-width:\s*100%/s
    );
    expect(css).toMatch(
      /\.agent-path-tail-label\s*{[^}]*display:\s*flex[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap/s
    );
    expect(css).toMatch(
      /\.agent-path-tail-label__directory\s*{[^}]*flex:\s*0 1 auto/s
    );
    expect(css).toMatch(
      /\.agent-path-tail-label__file\s*{[^}]*flex:\s*0 0 auto[^}]*max-width:\s*100%/s
    );
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

  it("renders transport retry notices as quiet text", () => {
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
    expect(notice.className).toContain("text-[var(--text-primary)]");
    expect(notice.className).not.toContain("rounded-[8px]");
    expect(queryByText("agentHost.agentGui.visibleErrorDetails")).toBeNull();
    expect(
      queryByText("Codex connection interrupted. Reconnecting...")
    ).toBeNull();
    expect(
      queryByText("agentHost.agentGui.systemNoticeTransportRetry")
    ).toBeNull();
  });

  it("renders transport fallback notices with danger chrome", () => {
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

    const notice = getByRole("status");
    expect(notice.className).toContain("border-[var(--on-danger-hover)]");
    expect(notice.className).toContain("bg-[var(--on-danger)]");
    expect(notice.className).not.toContain("var(--state-warning)_6%");
    expect(
      getByText("agentHost.agentGui.systemNoticeTransportFallback")
    ).toBeTruthy();
  });

  it("renders fallback warning notices with danger chrome", () => {
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

    const notice = getByRole("status");
    expect(notice.className).toContain("border-[var(--on-danger-hover)]");
    expect(notice.className).toContain("bg-[var(--on-danger)]");
    expect(notice.className).not.toContain("var(--state-warning)_6%");
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
    expect(notice.className).toContain("items-center");
    expect(notice.className).toContain("text-[var(--text-secondary)]");
    expect(notice.className).not.toContain("rounded-[8px]");
    const dividers = notice.querySelectorAll('span[aria-hidden="true"]');
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) {
      expect(divider.className).toContain("bg-[var(--line-1)]");
    }
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
      expect(notice.className).toContain("items-center");
      expect(notice.className).not.toContain("rounded-[8px]");
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
    expect(notice.className).not.toContain("rounded-[8px]");
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
