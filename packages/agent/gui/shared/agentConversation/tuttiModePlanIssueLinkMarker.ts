// Parses the durable plan→Issue reverse-link annotation the daemon writes
// after the user accepts a Tutti Mode plan.
//
// Wire contract (must stay in sync with ReportIssuePlanningLink in
// services/tuttid/service/agent/issue_planning_timeline.go):
//
//   MessageID:       "plan-issue:<issueID>"
//   Kind:            "session_audit", Role: "assistant"
//   Payload.content: "[@<escaped title>](mention://workspace-issue/<issueID>?workspaceId=…)"
//
// Detection keys on the stable message identity (the messageId prefix) plus
// the exact single-mention markdown shape — never on prose — mirroring
// tuttiModeCheckpointWakeMarker. A plan-issue message whose body does not
// parse degrades to the regular assistant markdown rendering (still friendly,
// never the notice/error surface).

import { parseRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import type { AgentTuttiPlanIssueLinkVM } from "./contracts/agentMessageRowVM";

export const TUTTI_PLAN_ISSUE_LINK_MESSAGE_ID_PREFIX = "plan-issue:";

const WORKSPACE_ISSUE_MENTION_PROVIDER_ID = "workspace-issue";

export function isTuttiPlanIssueLinkMessageId(
  messageId: string | null | undefined
): boolean {
  const trimmed = messageId?.trim() ?? "";
  return (
    trimmed.startsWith(TUTTI_PLAN_ISSUE_LINK_MESSAGE_ID_PREFIX) &&
    trimmed.length > TUTTI_PLAN_ISSUE_LINK_MESSAGE_ID_PREFIX.length
  );
}

export function parseTuttiPlanIssueLink(
  messageId: string | null | undefined,
  body: string | null | undefined
): AgentTuttiPlanIssueLinkVM | null {
  if (!isTuttiPlanIssueLinkMessageId(messageId)) {
    return null;
  }
  const markdown = body?.trim() ?? "";
  // The body must be exactly one markdown link. The daemon escapes []()\ in
  // the label and percent-encodes the href, so "](" only occurs as the
  // label/href separator.
  if (!markdown.startsWith("[") || !markdown.endsWith(")")) {
    return null;
  }
  const separatorIndex = markdown.lastIndexOf("](");
  if (separatorIndex <= 0) {
    return null;
  }
  const rawLabel = markdown.slice(1, separatorIndex);
  const href = markdown.slice(separatorIndex + 2, -1).trim();
  if (rawLabel.includes("](") || rawLabel.includes("\n") || !href) {
    return null;
  }
  const mention = parseRichTextMentionHref(href, rawLabel);
  if (
    !mention ||
    mention.providerId.trim().toLowerCase() !==
      WORKSPACE_ISSUE_MENTION_PROVIDER_ID ||
    !mention.entityId.trim()
  ) {
    return null;
  }
  const issueId = mention.entityId.trim();
  const title =
    unescapeMarkdownLabel(rawLabel.replace(/^@+/u, "").trim()) || issueId;
  return { issueId, title, mentionMarkdown: markdown };
}

/** Inverse of the daemon's label escaper (\\, \[, \], \(, \)). */
function unescapeMarkdownLabel(label: string): string {
  return label.replace(/\\([\\[\]()])/gu, "$1");
}
