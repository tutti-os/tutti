import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  messageCenterStackPreviewNodes,
  messageCenterStackPreviewText,
  WorkspaceAgentMessageCenterCard
} from "./WorkspaceAgentMessageCenterCard";
import type { WorkspaceAgentMessageCenterItem } from "./workspaceAgentMessageCenterModel";

describe("messageCenterStackPreviewText", () => {
  it("renders agent-session mention links as plain text instead of raw markdown", () => {
    const text = messageCenterStackPreviewText(
      item({
        summary:
          "[@查看昨天提交的代码](mention://agent-session/e8399a9c-da59-485c-b0bf-68c745d36867?workspaceId=ws-1)"
      })
    );

    expect(text).not.toContain("mention://");
    expect(text).not.toContain("[@");
    expect(text).toContain("查看昨天提交的代码");
  });
});

describe("messageCenterStackPreviewNodes", () => {
  it("renders a session mention as a static chip with the session icon", () => {
    const { container } = render(
      <>
        {messageCenterStackPreviewNodes(
          item({
            summary:
              "[@查看昨天提交的代码](mention://agent-session/e8399a9c-da59-485c-b0bf-68c745d36867?workspaceId=ws-1)"
          })
        )}
      </>
    );

    const chip = container.querySelector('[data-agent-mention-kind="session"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.textContent).toContain("查看昨天提交的代码");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("mention://");
  });

  it("renders workspace-issue and workspace-app mentions with their own icon", () => {
    const { container } = render(
      <>
        {messageCenterStackPreviewNodes(
          item({
            summary:
              "[@修一下这个 bug](mention://workspace-issue/issue-1?workspaceId=ws-1) [@AI 文档](mention://workspace-app/ai-doc?workspaceId=ws-1)"
          })
        )}
      </>
    );

    expect(
      container.querySelector('[data-agent-mention-kind="workspace-issue"]')
        ?.textContent
    ).toContain("修一下这个 bug");
    expect(
      container.querySelector('[data-agent-mention-kind="workspace-app"]')
        ?.textContent
    ).toContain("AI 文档");
  });
});

describe("WorkspaceAgentMessageCenterCard prompt presentation", () => {
  it("supports a full prompt without repeating the digest summary", () => {
    const pendingItem = item({ summary: "Allow the complete command?" });
    pendingItem.status = "waiting";
    pendingItem.pendingInteractionTarget = {
      agentSessionId: "codex-1",
      turnId: "turn-1",
      requestId: "request-1"
    };
    pendingItem.pendingPrompt = {
      kind: "approval",
      id: "approval:request-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Run command",
      toolName: "Bash",
      status: "pending",
      input: { command: "printf a && printf b" },
      options: [{ id: "allow", label: "Allow", kind: "allow" }],
      output: null,
      occurredAtUnixMs: 1
    };

    const { container } = render(
      <WorkspaceAgentMessageCenterCard
        item={pendingItem}
        isSubmitting={false}
        promptVariant="full"
        showSummaryWithPrompt={false}
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByText("printf a && printf b")).toBeTruthy();
    expect(screen.queryByText("Allow the complete command?")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(container.textContent).not.toContain("Allow the complete command?");
  });

  it("keeps the summary when a leaving or read-only card cannot render its prompt", () => {
    const pendingItem = item({ summary: "Allow the complete command?" });
    pendingItem.status = "waiting";
    pendingItem.pendingPrompt = {
      kind: "approval",
      id: "approval:request-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Run command",
      toolName: "Bash",
      status: "pending",
      input: { command: "printf a && printf b" },
      options: [{ id: "allow", label: "Allow", kind: "allow" }],
      output: null,
      occurredAtUnixMs: 1
    };

    render(
      <WorkspaceAgentMessageCenterCard
        interactive={false}
        item={pendingItem}
        isSubmitting={false}
        promptVariant="full"
        showSummaryWithPrompt={false}
        onOpenChat={() => undefined}
        onSubmitPrompt={() => undefined}
      />
    );

    expect(screen.getByText("Allow the complete command?")).toBeTruthy();
    expect(screen.queryByText("printf a && printf b")).toBeNull();
  });
});

function item(overrides: { summary: string }): WorkspaceAgentMessageCenterItem {
  return {
    id: "message-center-codex-1",
    agentSessionId: "codex-1",
    provider: "codex",
    userId: null,
    title: "codex-1",
    identity: null,
    cwd: "/workspace",
    status: "working",
    digest: {
      primary: {
        kind: "progress",
        summary: overrides.summary,
        occurredAtUnixMs: 1
      }
    },
    lastAgentMessageSummary: "",
    lastAgentMessageAtUnixMs: 1,
    pendingInteractionTarget: null,
    pendingPrompt: null,
    needsAttentionKind: null,
    needsAttentionSummary: null,
    sortTimeUnixMs: 1
  };
}
