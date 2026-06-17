import { createRichTextMentionAttrs } from "./mention.ts";
import {
  createRichTextMentionMarkdown,
  createRichTextLinkMarkdown
} from "../core/richTextDocument.ts";
import type {
  RichTextTriggerProvider,
  RichTextMarkdownLinkInsertResult,
  RichTextMentionTriggerInsertResult,
  RichTextTriggerInsertResult,
  RichTextTextInsertResult
} from "../types/trigger.ts";

function normalizeRequiredString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Rich text ${fieldName} is required.`);
  }
  return trimmed;
}

export function createRichTextTextInsertResult(
  text: string
): RichTextTextInsertResult {
  return {
    kind: "text",
    text
  };
}

export function createRichTextMarkdownLinkInsertResult(
  label: string,
  href: string
): RichTextMarkdownLinkInsertResult {
  return {
    kind: "markdown-link",
    label: normalizeRequiredString(label, "insert label"),
    href: normalizeRequiredString(href, "insert href")
  };
}

export function createRichTextMentionInsertResult(
  mention: RichTextMentionTriggerInsertResult["mention"]
): RichTextMentionTriggerInsertResult {
  return {
    kind: "mention",
    mention
  };
}

export function renderRichTextTriggerInsertResult(
  providerId: string,
  result: RichTextTriggerInsertResult
): string {
  switch (result.kind) {
    case "mention":
      return createRichTextMentionMarkdown(
        createRichTextMentionAttrs(providerId, result.mention)
      );
    case "markdown-link":
      return createRichTextLinkMarkdown({
        name: result.label,
        path: result.href,
        kind: result.href.endsWith("/") ? "folder" : "file"
      });
    case "text":
      return result.text;
    default:
      return "";
  }
}

export function createRichTextTriggerProvider<TItem>(
  provider: RichTextTriggerProvider<TItem>
): RichTextTriggerProvider<TItem> {
  const id = normalizeRequiredString(provider.id, "provider id");

  return {
    ...provider,
    id
  };
}
