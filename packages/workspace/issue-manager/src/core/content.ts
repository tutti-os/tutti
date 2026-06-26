import {
  appendRichTextLinksToContent,
  createRichTextLinkMarkdown,
  createRichTextMentionHref,
  createRichTextMentionMarkdown,
  extractPlainTextFromContent,
  extractPlainTextWithoutFilesFromContent,
  extractRichTextLinksFromContent,
  extractRichTextMentionsFromContent,
  normalizeRichTextContent,
  normalizeRichTextLinkHref,
  parseRichTextMentionHref,
  removeRichTextLinkFromContent,
  removeRichTextMentionFromContent
} from "@tutti-os/ui-rich-text/core";
import type {
  RichTextLinkInput,
  RichTextLinkRef
} from "@tutti-os/ui-rich-text/core";
import type { RichTextMentionAttrs } from "@tutti-os/ui-rich-text/types";

export type IssueManagerWorkspaceFileLinkRef = RichTextLinkRef;
export type IssueManagerWorkspaceFileLinkInput = RichTextLinkInput;

export type IssueManagerMentionRef = RichTextMentionAttrs;
export type IssueManagerMentionAttrs = RichTextMentionAttrs;

export const normalizeIssueManagerContent = normalizeRichTextContent;

export const normalizeIssueManagerWorkspaceFileLinkHref =
  normalizeRichTextLinkHref;

export const createIssueManagerWorkspaceFileLinkMarkdown =
  createRichTextLinkMarkdown;

export const appendIssueManagerWorkspaceFileLinksToContent =
  appendRichTextLinksToContent;

export const extractIssueManagerWorkspaceFileLinksFromContent =
  extractRichTextLinksFromContent;

export const removeIssueManagerWorkspaceFileLinkFromContent =
  removeRichTextLinkFromContent;

export const extractIssueManagerPlainTextFromContent =
  extractPlainTextFromContent;

export const extractIssueManagerPlainTextWithoutFilesFromContent =
  extractPlainTextWithoutFilesFromContent;

export const createIssueManagerMentionHref = createRichTextMentionHref;
export const createIssueManagerMentionMarkdown = createRichTextMentionMarkdown;
export const parseIssueManagerMentionHref = parseRichTextMentionHref;

export interface IssueManagerWorkspaceReferenceMentionInput {
  source: "app" | "task";
  id: string;
  groupId?: string | null;
  displayName: string;
  iconUrl?: string | null;
  fileCount?: number;
  workspaceId: string;
}

/**
 * 把一个「项目/分组」折叠成单条 `mention://workspace-reference/...` chip 的 markdown。
 * 句柄(source + id + groupId)随 query 编码,运行时交给 agent 解析;count 仅供展示。
 * 与 agent 端 `buildAgentWorkspaceReferenceMentionHref` 的参数名保持一致。
 */
export function createIssueManagerWorkspaceReferenceMentionMarkdown(
  input: IssueManagerWorkspaceReferenceMentionInput
): string {
  const id = input.id.trim();
  const displayName = input.displayName.trim();
  if (!id || !displayName) {
    return "";
  }
  const scope: Record<string, string> = {
    workspaceId: input.workspaceId,
    source: input.source
  };
  const groupId = input.groupId?.trim();
  if (groupId) {
    scope.groupId = groupId;
  }
  if (input.fileCount != null && input.fileCount > 0) {
    scope.count = String(input.fileCount);
  }
  return createRichTextMentionMarkdown({
    providerId: "workspace-reference",
    entityId: id,
    label: displayName,
    scope
  });
}

/**
 * 把若干项目 chip 追加到内容尾部(以空格分隔,沿用文件链接的拼接形态)。
 */
export function appendIssueManagerWorkspaceReferenceMentionsToContent(
  content: string,
  bundles: readonly IssueManagerWorkspaceReferenceMentionInput[]
): string {
  const base = normalizeRichTextContent(content);
  const rendered = bundles
    .map((bundle) =>
      createIssueManagerWorkspaceReferenceMentionMarkdown(bundle)
    )
    .filter((markdown) => markdown.length > 0);
  if (rendered.length === 0) {
    return base;
  }
  return base ? `${base} ${rendered.join(" ")}` : rendered.join(" ");
}
export const extractIssueManagerMentionsFromContent =
  extractRichTextMentionsFromContent;
export const removeIssueManagerMentionFromContent =
  removeRichTextMentionFromContent;
