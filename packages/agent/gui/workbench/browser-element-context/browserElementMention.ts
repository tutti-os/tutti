import { createRichTextMentionMarkdown } from "@tutti-os/ui-rich-text/core";

export const browserElementMentionKind = "browser-element";

export interface BrowserElementMentionReference {
  context: string;
  id: string;
  tagName: string;
  workspaceId: string;
}

export interface BrowserElementMentionIdentity {
  label: string;
  scope?: Readonly<Record<string, string>>;
}

export interface BrowserElementMentionPresentation {
  name: string;
  workspaceId?: string;
}

export function createBrowserElementMentionMarkdown(
  reference: BrowserElementMentionReference
): string {
  const tagName = normalizeBrowserElementTagName(reference.tagName);
  const context = reference.context.trim();
  const workspaceId = reference.workspaceId.trim();
  if (!tagName || !context || !workspaceId) {
    return "";
  }
  return createRichTextMentionMarkdown({
    providerId: browserElementMentionKind,
    entityId: reference.id,
    label: tagName,
    scope: { context, tag: tagName, workspaceId }
  });
}

export function browserElementMentionLabel(tagName: string): string {
  const normalized = normalizeBrowserElementTagName(tagName);
  return normalized ? `<${normalized}>` : "";
}

export function presentBrowserElementMention(
  mention: BrowserElementMentionIdentity
): BrowserElementMentionPresentation | null {
  const label = browserElementMentionLabel(
    mention.scope?.tag?.trim() || mention.label
  );
  if (!label) {
    return null;
  }
  const workspaceId = mention.scope?.workspaceId?.trim() ?? "";
  return {
    name: label,
    ...(workspaceId ? { workspaceId } : {})
  };
}

function normalizeBrowserElementTagName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:-]/gu, "")
    .slice(0, 100);
}
