import type { MentionPillKind } from "@tutti-os/ui-system/components";
import type {
  RichTextMentionIdentity,
  RichTextMentionPresentation
} from "../types/mention.ts";

function readStringAttr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readMentionPresentationUrl(
  presentation: RichTextMentionPresentation | null | undefined
): string | null {
  const value = presentation?.iconUrl ?? presentation?.thumbnailUrl;
  const trimmed = readStringAttr(value);
  return trimmed || null;
}

export function readMentionScopeValue(
  scope: RichTextMentionIdentity["scope"] | null | undefined,
  key: string
): string {
  return readStringAttr(scope?.[key]);
}

export function resolveMentionPillKind(
  providerId: string,
  scope: RichTextMentionIdentity["scope"] | null | undefined
): MentionPillKind {
  const id = providerId.trim();
  if (id === "agent-session" || id === "session") {
    return "session";
  }
  if (id === "workspace-app") {
    return "app";
  }
  if (id === "workspace-issue") {
    return "issue";
  }
  if (id === "workspace-reference") {
    return readMentionScopeValue(scope, "source") === "task" ? "issue" : "app";
  }
  if (id === "file") {
    return "file";
  }
  return "issue";
}

export function resolveMentionPillIconUrl(input: {
  presentation?: RichTextMentionPresentation | null;
  scope?: RichTextMentionIdentity["scope"] | null;
}): string | null {
  return (
    readMentionPresentationUrl(input.presentation) ||
    readMentionScopeValue(input.scope, "icon") ||
    null
  );
}
