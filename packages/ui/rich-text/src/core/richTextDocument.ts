import type { JSONContent } from "@tiptap/core";
import {
  mentionReferenceNodeName,
  workspaceReferenceNodeName
} from "../extensions/names.ts";
import type {
  RichTextMentionAttrs,
  RichTextMentionIdentity
} from "../types/mention.ts";
import {
  findRichTextMarkdownLinks,
  type RichTextMarkdownLinkMatch
} from "./richTextMarkdownLinks.ts";

export type RichTextLinkRef = {
  name: string;
  path: string;
  href: string;
  kind: "file" | "folder";
};

export type RichTextLinkInput = {
  name?: string | null;
  path: string;
  kind?: "file" | "folder";
};

export type RichTextMentionRef = RichTextMentionAttrs;
export type RichTextDocument = JSONContent;

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const EXTERNAL_LINK_PREFIX = /^(?:[a-z]+:)?\/\//i;
const MENTION_LINK_PREFIX = /^mention:\/\//i;
const RESERVED_MENTION_SCOPE_KEYS = new Set([
  "appId",
  "id",
  "kind",
  "link",
  "provider",
  "v",
  "version"
]);
const PRESENTATION_MENTION_CONTEXT_KEYS = new Set([
  "agentIconUrl",
  "iconUrl",
  "thumbnailUrl",
  "userAvatarPlaceholderUrl"
]);
const DEFAULT_MENTION_CONTEXT_MAX_VALUE_LENGTH = 2048;

export interface RichTextMentionAgentContext {
  providerId: string;
  entityId: string;
  label: string;
  scope?: Readonly<Record<string, string>>;
}

export interface SanitizeRichTextMentionContextOptions {
  maxValueLength?: number;
}

type LegacyJSONContentNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: LegacyJSONContentNode[];
};

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeContentString(value?: string | null): string {
  const trimmed = normalizeLineEndings(value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const markdown = convertLegacyDocumentString(trimmed);
  return markdown || trimmed;
}

export function normalizeRichTextContent(value?: string | null): string {
  return normalizeContentString(value);
}

function convertLegacyDocumentString(value: string): string {
  try {
    const parsed = JSON.parse(value) as LegacyJSONContentNode;
    if (parsed?.type !== "doc" || !Array.isArray(parsed.content)) {
      return "";
    }
    return renderLegacyNodesToMarkdown(parsed.content).trim();
  } catch {
    return "";
  }
}

function renderLegacyNodesToMarkdown(nodes: LegacyJSONContentNode[]): string {
  return nodes
    .map((node) => renderLegacyNodeToMarkdown(node))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function renderLegacyNodeToMarkdown(
  node: LegacyJSONContentNode | null | undefined
): string {
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.text ?? "";
  }
  if (node.type === "workspaceFileLink") {
    const attrs = node.attrs ?? {};
    const kind = attrs.kind === "folder" ? "folder" : "file";
    const hrefValue =
      (typeof attrs.href === "string" ? attrs.href : undefined) ||
      (typeof attrs.path === "string" ? attrs.path : undefined) ||
      "";
    const href = normalizeRichTextLinkHref(hrefValue, kind);
    const label =
      (typeof attrs.name === "string" ? attrs.name : undefined)?.trim() ||
      href.split("/").filter(Boolean).at(-1) ||
      href;
    return href && label ? `[${label}](${href})` : label;
  }
  if (Array.isArray(node.content)) {
    const inline = node.content
      .map((child) => renderLegacyNodeToMarkdown(child))
      .filter((part) => part.length > 0)
      .join("")
      .trim();
    if (!inline) {
      return "";
    }
    if (node.type === "paragraph") {
      return inline;
    }
    return inline;
  }
  return "";
}

function normalizeWorkspacePath(
  pathOrHref: string,
  kind: "file" | "folder"
): string {
  const trimmed = pathOrHref.trim();
  if (!trimmed) {
    return "";
  }
  if (kind === "folder" && !trimmed.endsWith("/")) {
    return `${trimmed}/`;
  }
  return trimmed;
}

function isWorkspaceReferenceHref(href: string): boolean {
  const trimmed = href.trim();
  if (
    !trimmed ||
    MENTION_LINK_PREFIX.test(trimmed) ||
    EXTERNAL_LINK_PREFIX.test(trimmed)
  ) {
    return false;
  }
  return true;
}

export function isRichTextMentionHref(href: string): boolean {
  return MENTION_LINK_PREFIX.test(href.trim());
}

function normalizeMentionLabel(value: string): string {
  return value.trim().replace(/^@+/, "").trim();
}

function isReservedMentionScopeKey(key: string): boolean {
  return RESERVED_MENTION_SCOPE_KEYS.has(key) || key.startsWith("meta.");
}

function isPresentationMentionContextKey(key: string): boolean {
  return PRESENTATION_MENTION_CONTEXT_KEYS.has(key);
}

function isUnsafeMentionContextValue(value: string, maxValueLength: number) {
  const normalizedValue = value.toLowerCase();
  return (
    value.length > maxValueLength ||
    normalizedValue.startsWith("data:") ||
    normalizedValue.startsWith("blob:")
  );
}

export function sanitizeRichTextMentionScopeForAgentContext(
  scope?: Readonly<Record<string, unknown>> | null,
  options: SanitizeRichTextMentionContextOptions = {}
): Record<string, string> | undefined {
  if (!scope) {
    return undefined;
  }
  const maxValueLength =
    options.maxValueLength && options.maxValueLength > 0
      ? options.maxValueLength
      : DEFAULT_MENTION_CONTEXT_MAX_VALUE_LENGTH;
  const nextScope: Record<string, string> = {};
  for (const [key, value] of Object.entries(scope).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const nextKey = key.trim();
    if (
      !nextKey ||
      isReservedMentionScopeKey(nextKey) ||
      isPresentationMentionContextKey(nextKey) ||
      typeof value !== "string"
    ) {
      continue;
    }
    const nextValue = value.trim();
    if (!nextValue || isUnsafeMentionContextValue(nextValue, maxValueLength)) {
      continue;
    }
    nextScope[nextKey] = nextValue;
  }
  return Object.keys(nextScope).length ? nextScope : undefined;
}

export function sanitizeRichTextMentionForAgentContext(
  mention: {
    providerId?: string | null;
    entityId?: string | null;
    label?: string | null;
    scope?: Readonly<Record<string, unknown>> | null;
  },
  options: SanitizeRichTextMentionContextOptions = {}
): RichTextMentionAgentContext | undefined {
  const providerId = mention.providerId?.trim() ?? "";
  const entityId = mention.entityId?.trim() ?? "";
  const label = normalizeMentionLabel(mention.label ?? "") || entityId;
  if (!providerId || !entityId || !label) {
    return undefined;
  }
  const scope = sanitizeRichTextMentionScopeForAgentContext(
    mention.scope,
    options
  );
  return {
    providerId,
    entityId,
    label,
    ...(scope ? { scope } : {})
  };
}

function createMentionQueryParams(
  mention: RichTextMentionIdentity
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(mention.scope ?? {}).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const nextKey = key.trim();
    const nextValue = value.trim();
    if (!nextKey || !nextValue || isReservedMentionScopeKey(nextKey)) {
      continue;
    }
    params.set(nextKey, nextValue);
  }
  return params;
}

export function createRichTextMentionHref(
  mention: RichTextMentionIdentity
): string {
  const providerId = mention.providerId.trim();
  const entityId = mention.entityId.trim();
  const label = normalizeMentionLabel(mention.label);
  if (!providerId || !entityId || !label) {
    return "";
  }

  const params = createMentionQueryParams(mention);
  const queryString = params.toString();
  const pathname = `${encodeURIComponent(providerId)}/${encodeURIComponent(entityId).replace(/%3A/giu, ":")}`;
  return queryString
    ? `mention://${pathname}?${queryString}`
    : `mention://${pathname}`;
}

export function createRichTextMentionMarkdown(
  mention: RichTextMentionIdentity
): string {
  const label = normalizeMentionLabel(mention.label);
  const href = createRichTextMentionHref(mention);
  if (!label || !href) {
    return "";
  }
  return `[${escapeMarkdownLinkLabel(`@${label}`)}](${escapeMarkdownLinkHref(href)})`;
}

export function parseRichTextMentionHref(
  href: string,
  label?: string | null
): RichTextMentionRef | null {
  const trimmedHref = href.trim();
  if (!isRichTextMentionHref(trimmedHref)) {
    return null;
  }

  try {
    const parsed = new URL(trimmedHref);
    const providerId = decodeURIComponent(parsed.hostname).trim();
    const encodedEntityId = parsed.pathname.replace(/^\/+/, "");
    const entityId = decodeURIComponent(encodedEntityId).trim();
    const rawLabel = normalizeMentionLabel(label?.trim() ?? "");

    if (
      !providerId ||
      !encodedEntityId ||
      encodedEntityId.includes("/") ||
      !entityId
    ) {
      return null;
    }

    const nextLabel = rawLabel || entityId;

    const scopeEntries: Array<readonly [string, string]> = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      const scopeKey = key.trim();
      const scopeValue = value.trim();
      if (!scopeKey || isReservedMentionScopeKey(scopeKey)) {
        return null;
      }
      if (scopeValue) {
        scopeEntries.push([scopeKey, scopeValue]);
      }
    }

    const mention: RichTextMentionRef = {
      trigger: "@",
      providerId,
      entityId,
      label: nextLabel
    };
    if (scopeEntries.length > 0) {
      mention.scope = Object.fromEntries(scopeEntries);
    }
    return mention;
  } catch {
    return null;
  }
}

export function normalizeRichTextLinkHref(
  pathOrHref: string,
  kind: "file" | "folder" = "file"
): string {
  return normalizeWorkspacePath(pathOrHref, kind);
}

export function createRichTextLinkMarkdown(input: RichTextLinkInput): string {
  const kind = input.kind === "folder" ? "folder" : "file";
  const href = normalizeRichTextLinkHref(input.path, kind);
  const displayName =
    input.name?.trim() ||
    href.split("/").filter(Boolean).at(-1) ||
    href ||
    input.path.trim();
  if (!href || !displayName) {
    return "";
  }
  return `[${escapeMarkdownLinkLabel(displayName)}](${escapeMarkdownLinkHref(href)})`;
}

export function appendRichTextLinksToContent(
  value: string | null | undefined,
  refs: readonly RichTextLinkInput[]
): string {
  const content = normalizeContentString(value);
  const existing = new Set(
    extractRichTextLinksFromContent(content).map((ref) => ref.path)
  );
  const rendered = refs
    .map((ref) => {
      const kind = ref.kind === "folder" ? "folder" : "file";
      const path = normalizeRichTextLinkHref(ref.path, kind);
      if (!path || existing.has(path)) {
        return "";
      }
      existing.add(path);
      return createRichTextLinkMarkdown({ ...ref, path, kind });
    })
    .filter(Boolean);

  if (rendered.length === 0) {
    return content;
  }
  return content ? `${content} ${rendered.join(" ")}` : rendered.join(" ");
}

export function extractRichTextLinksFromContent(
  value: string | null | undefined
): RichTextLinkRef[] {
  const content = normalizeContentString(value);
  const refs = new Map<string, RichTextLinkRef>();
  for (const match of findRichTextMarkdownLinks(content)) {
    const name = match.label.trim();
    const href = match.href.trim();
    if (!name || !isWorkspaceReferenceHref(href)) {
      continue;
    }
    const kind = href.endsWith("/") ? "folder" : "file";
    const path = normalizeRichTextLinkHref(href, kind);
    if (!path || refs.has(path)) {
      continue;
    }
    refs.set(path, {
      name,
      path,
      href: path,
      kind
    });
  }
  return [...refs.values()];
}

export function extractRichTextMentionsFromContent(
  value: string | null | undefined
): RichTextMentionRef[] {
  const content = normalizeContentString(value);
  const refs = new Map<string, RichTextMentionRef>();

  for (const match of findRichTextMarkdownLinks(content)) {
    const label = match.label.trim();
    const href = match.href.trim();
    const mention = parseRichTextMentionHref(href, label);
    if (!mention) {
      continue;
    }
    const mentionKey = [
      mention.providerId,
      mention.entityId,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(mention.scope ?? {}).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      )
    ].join(":");
    if (refs.has(mentionKey)) {
      continue;
    }
    refs.set(mentionKey, mention);
  }

  return [...refs.values()];
}

export function removeRichTextMentionFromContent(
  content: string,
  mention: Pick<RichTextMentionAttrs, "providerId" | "entityId">
): string {
  const providerId = mention.providerId.trim();
  const entityId = mention.entityId.trim();
  if (!providerId || !entityId) {
    return normalizeContentString(content);
  }

  const normalized = normalizeContentString(content);
  const next = replaceRichTextMarkdownLinks(normalized, (match) => {
    const parsedMention = parseRichTextMentionHref(match.href, match.label);
    if (!parsedMention) {
      return match.source;
    }
    return parsedMention.providerId === providerId &&
      parsedMention.entityId === entityId
      ? ""
      : match.source;
  });

  return next
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function removeRichTextLinkFromContent(
  content: string,
  path: string
): string {
  const targetPath = path.trim();
  if (!targetPath) {
    return normalizeContentString(content);
  }
  const normalized = normalizeContentString(content);
  const next = replaceRichTextMarkdownLinks(normalized, (match) => {
    const href = match.href.trim();
    const kind = href.endsWith("/") ? "folder" : "file";
    const refPath = normalizeRichTextLinkHref(href, kind);
    return refPath === targetPath ? "" : match.source;
  });
  return next
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractPlainTextFromContent(value?: string | null): string {
  const content = normalizeContentString(value);
  if (!content) {
    return "";
  }
  return replaceRichTextMarkdownLinks(
    content.replace(MARKDOWN_IMAGE_PATTERN, " $1 "),
    (match) => ` ${match.label} `
  )
    .replace(/^[\s>*#+-]+/gm, " ")
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/[*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractPlainTextWithoutFilesFromContent(
  value?: string | null
): string {
  const content = normalizeContentString(value);
  if (!content) {
    return "";
  }
  return replaceRichTextMarkdownLinks(
    content.replace(MARKDOWN_IMAGE_PATTERN, " "),
    () => " "
  )
    .replace(/^[\s>*#+-]+/gm, " ")
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/[*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRichTextContentToDocument(
  value?: string | null
): RichTextDocument {
  const content = normalizeContentString(value);
  if (!content) {
    return {
      type: "doc",
      content: [{ type: "paragraph" }]
    };
  }

  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => createRichTextParagraphNode(paragraph))
    .filter((paragraph) => Array.isArray(paragraph.content));

  return {
    type: "doc",
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph" }]
  };
}

export function serializeRichTextDocumentToContent(
  document: RichTextDocument
): string {
  const paragraphs = (document.content ?? [])
    .map((node) => serializeRichTextBlockNode(node))
    .filter((value) => value.length > 0);

  return paragraphs.join("\n\n").trim();
}

function createRichTextParagraphNode(paragraph: string): JSONContent {
  return {
    type: "paragraph",
    content: createRichTextInlineNodes(paragraph)
  };
}

function createRichTextInlineNodes(text: string): JSONContent[] {
  const content: JSONContent[] = [];
  let cursor = 0;

  for (const match of findRichTextMarkdownLinks(text)) {
    const { index, source } = match;
    if (index > cursor) {
      appendPlainTextNodes(content, text.slice(cursor, index));
    }

    const label = match.label.trim();
    const href = match.href.trim();
    const mention = parseRichTextMentionHref(href, label);
    if (mention) {
      content.push({
        type: mentionReferenceNodeName,
        attrs: mention
      });
    } else if (label && isWorkspaceReferenceHref(href)) {
      const kind = href.endsWith("/") ? "folder" : "file";
      content.push({
        type: workspaceReferenceNodeName,
        attrs: {
          kind,
          label,
          path: normalizeRichTextLinkHref(href, kind)
        }
      });
    } else {
      appendPlainTextNodes(content, source);
    }

    cursor = match.to;
  }

  if (cursor < text.length) {
    appendPlainTextNodes(content, text.slice(cursor));
  }

  return content;
}

function replaceRichTextMarkdownLinks(
  value: string,
  replace: (match: RichTextMarkdownLinkMatch) => string
): string {
  let nextValue = "";
  let cursor = 0;

  for (const match of findRichTextMarkdownLinks(value)) {
    nextValue += value.slice(cursor, match.index);
    nextValue += replace(match);
    cursor = match.to;
  }

  return `${nextValue}${value.slice(cursor)}`;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&");
}

function escapeMarkdownLinkHref(value: string): string {
  return value.replace(/[\\()]/g, "\\$&");
}

function appendPlainTextNodes(content: JSONContent[], text: string): void {
  if (!text) {
    return;
  }

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.length > 0) {
      content.push({
        type: "text",
        text: line
      });
    }
    if (index < lines.length - 1) {
      content.push({ type: "hardBreak" });
    }
  });
}

function serializeRichTextBlockNode(node: JSONContent): string {
  if (node.type === "paragraph") {
    return serializeRichTextInlineNodes(node.content ?? []);
  }
  return serializeRichTextInlineNodes(node.content ?? []);
}

function serializeRichTextInlineNodes(nodes: readonly JSONContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return typeof node.text === "string" ? node.text : "";
      }
      if (node.type === "hardBreak") {
        return "\n";
      }
      if (node.type === workspaceReferenceNodeName) {
        const attrs = node.attrs ?? {};
        return createRichTextLinkMarkdown({
          kind: attrs.kind === "folder" ? "folder" : "file",
          name: typeof attrs.label === "string" ? attrs.label : "",
          path: typeof attrs.path === "string" ? attrs.path : ""
        });
      }
      if (node.type === mentionReferenceNodeName) {
        const attrs = node.attrs ?? {};
        const label = typeof attrs.label === "string" ? attrs.label.trim() : "";
        const providerId =
          typeof attrs.providerId === "string" ? attrs.providerId.trim() : "";
        const entityId =
          typeof attrs.entityId === "string" ? attrs.entityId.trim() : "";
        if (!label || !providerId || !entityId) {
          return "";
        }
        const scope =
          attrs.scope && typeof attrs.scope === "object"
            ? (attrs.scope as Record<string, string>)
            : undefined;
        return createRichTextMentionMarkdown({
          entityId,
          label,
          providerId,
          scope
        });
      }

      if (Array.isArray(node.content)) {
        return serializeRichTextInlineNodes(node.content);
      }

      return "";
    })
    .join("");
}
