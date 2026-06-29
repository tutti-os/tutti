import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  messageCenterStackPreviewNodes,
  messageCenterStackPreviewText
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
    pendingPrompt: null,
    needsAttentionKind: null,
    needsAttentionSummary: null,
    sortTimeUnixMs: 1
  };
}
