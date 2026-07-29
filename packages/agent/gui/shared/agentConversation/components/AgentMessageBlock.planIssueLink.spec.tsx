import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentMessageBlock } from "./AgentMessageBlock";
import type { AgentMessageRowVM } from "../contracts/agentMessageRowVM";

const MENTION =
  "[@修复登录问题](mention://workspace-issue/tutti-mode-plan-wf-1?topicId=topic-1&workspaceId=workspace-1)";

function buildPlanIssueLinkRow(): AgentMessageRowVM {
  return {
    kind: "message",
    id: "row-1",
    turnId: "plan-issue:tutti-mode-plan-wf-1",
    speaker: "assistant",
    occurredAtUnixMs: 0,
    thinking: [],
    messages: [
      {
        kind: "message-content",
        id: "plan-issue:tutti-mode-plan-wf-1",
        turnId: "plan-issue:tutti-mode-plan-wf-1",
        body: MENTION,
        presentationKind: "content",
        contentKind: "tutti-plan-issue-link",
        planIssueLink: {
          issueId: "tutti-mode-plan-wf-1",
          title: "修复登录问题",
          mentionMarkdown: MENTION
        },
        occurredAtUnixMs: 0
      }
    ]
  };
}

describe("AgentMessageBlock plan-issue link", () => {
  it("renders the plan Issue link as a friendly card with a clickable issue chip", () => {
    const onLinkAction = vi.fn();
    const { container, getByText, queryByText } = render(
      <AgentMessageBlock
        workspaceRoot="/workspace/demo"
        basePath="/"
        row={buildPlanIssueLinkRow()}
        onLinkAction={onLinkAction}
        thinkingLabel="thinking"
      />
    );

    const card = container.querySelector(
      '[data-testid="agent-tutti-plan-issue-link-card"]'
    );
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-plan-issue-id")).toBe(
      "tutti-mode-plan-wf-1"
    );
    // No raw markdown and no danger notice surface.
    expect(queryByText(MENTION)).toBeNull();
    expect(container.querySelector('[class*="on-danger"]')).toBeNull();

    // The mention chip resolves the click through the standard workspace-issue
    // link action pipeline.
    fireEvent.click(getByText("修复登录问题"));
    expect(onLinkAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-workspace-issue" })
    );
  });
});
