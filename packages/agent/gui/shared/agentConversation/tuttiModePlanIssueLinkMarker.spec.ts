import { describe, expect, it } from "vitest";
import {
  isTuttiPlanIssueLinkMessageId,
  parseTuttiPlanIssueLink
} from "./tuttiModePlanIssueLinkMarker";

const MENTION =
  "[@修复登录问题](mention://workspace-issue/tutti-mode-plan-wf-1?topicId=topic-1&workspaceId=workspace-1)";

describe("isTuttiPlanIssueLinkMessageId", () => {
  it("matches only non-empty plan-issue ids", () => {
    expect(isTuttiPlanIssueLinkMessageId("plan-issue:wf-1")).toBe(true);
    expect(isTuttiPlanIssueLinkMessageId(" plan-issue:wf-1 ")).toBe(true);
    expect(isTuttiPlanIssueLinkMessageId("plan-issue:")).toBe(false);
    expect(isTuttiPlanIssueLinkMessageId("collab:run-1")).toBe(false);
    expect(isTuttiPlanIssueLinkMessageId(undefined)).toBe(false);
  });
});

describe("parseTuttiPlanIssueLink", () => {
  it("parses the daemon reverse-link markdown into issue id and title", () => {
    expect(
      parseTuttiPlanIssueLink("plan-issue:tutti-mode-plan-wf-1", MENTION)
    ).toEqual({
      issueId: "tutti-mode-plan-wf-1",
      title: "修复登录问题",
      mentionMarkdown: MENTION
    });
  });

  it("unescapes the daemon's markdown label escapes", () => {
    const escaped =
      "[@Fix \\[login\\] flow \\(retry\\)](mention://workspace-issue/wf-2?workspaceId=w1)";
    expect(parseTuttiPlanIssueLink("plan-issue:wf-2", escaped)).toEqual({
      issueId: "wf-2",
      title: "Fix [login] flow (retry)",
      mentionMarkdown: escaped
    });
  });

  it("falls back to the issue id when the label is only the @ trigger", () => {
    const bare = "[@wf-3](mention://workspace-issue/wf-3?workspaceId=w1)";
    expect(parseTuttiPlanIssueLink("plan-issue:wf-3", bare)?.title).toBe(
      "wf-3"
    );
  });

  it("requires the plan-issue message identity", () => {
    expect(parseTuttiPlanIssueLink("message-1", MENTION)).toBeNull();
    expect(parseTuttiPlanIssueLink(undefined, MENTION)).toBeNull();
  });

  it("rejects bodies that are not exactly one workspace-issue mention", () => {
    expect(parseTuttiPlanIssueLink("plan-issue:wf-1", "plain text")).toBeNull();
    expect(
      parseTuttiPlanIssueLink("plan-issue:wf-1", `intro ${MENTION}`)
    ).toBeNull();
    expect(
      parseTuttiPlanIssueLink("plan-issue:wf-1", `${MENTION} trailing`)
    ).toBeNull();
    expect(
      parseTuttiPlanIssueLink(
        "plan-issue:wf-1",
        "[@other](mention://agent-session/session-1?workspaceId=w1)"
      )
    ).toBeNull();
    expect(parseTuttiPlanIssueLink("plan-issue:wf-1", "")).toBeNull();
  });
});
