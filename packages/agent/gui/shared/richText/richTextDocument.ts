import { isRichTextMentionHref } from "@tutti-os/ui-rich-text/core";

export type WorkspaceFileLinkRef = {
  name: string;
  path: string;
  href: string;
  kind: "file" | "folder";
};

export type WorkspaceFileLinkInput = {
  name?: string | null;
  path: string;
  kind?: "file" | "folder";
};

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const EXTERNAL_LINK_PREFIX = /^(?:[a-z]+:)?\/\//i;

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
    const href = normalizeWorkspaceFileLinkHref(hrefValue, kind);
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
    isRichTextMentionHref(trimmed) ||
    EXTERNAL_LINK_PREFIX.test(trimmed)
  ) {
    return false;
  }
  return true;
}

export function normalizeWorkspaceFileLinkHref(
  pathOrHref: string,
  kind: "file" | "folder" = "file"
): string {
  return normalizeWorkspacePath(pathOrHref, kind);
}

export function createWorkspaceFileLinkMarkdown(
  input: WorkspaceFileLinkInput
): string {
  const kind = input.kind === "folder" ? "folder" : "file";
  const href = normalizeWorkspaceFileLinkHref(input.path, kind);
  const displayName =
    input.name?.trim() ||
    href.split("/").filter(Boolean).at(-1) ||
    href ||
    input.path.trim();
  if (!href || !displayName) {
    return "";
  }
  return `[${displayName}](${href})`;
}

export function appendWorkspaceFileLinksToContent(
  value: string | null | undefined,
  refs: readonly WorkspaceFileLinkInput[]
): string {
  const content = normalizeContentString(value);
  const existing = new Set(
    extractWorkspaceFileLinksFromContent(content).map((ref) => ref.path)
  );
  const rendered = refs
    .map((ref) => {
      const kind = ref.kind === "folder" ? "folder" : "file";
      const path = normalizeWorkspaceFileLinkHref(ref.path, kind);
      if (!path || existing.has(path)) {
        return "";
      }
      existing.add(path);
      return createWorkspaceFileLinkMarkdown({ ...ref, path, kind });
    })
    .filter(Boolean);

  if (rendered.length === 0) {
    return content;
  }
  return content ? `${content}\n\n${rendered.join("\n")}` : rendered.join("\n");
}

export function extractWorkspaceFileLinksFromContent(
  value: string | null | undefined
): WorkspaceFileLinkRef[] {
  const content = normalizeContentString(value);
  const refs = new Map<string, WorkspaceFileLinkRef>();
  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    const name = match[1]?.trim() ?? "";
    const href = match[2]?.trim() ?? "";
    if (!name || !isWorkspaceReferenceHref(href)) {
      continue;
    }
    const kind = href.endsWith("/") ? "folder" : "file";
    const path = normalizeWorkspaceFileLinkHref(href, kind);
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

export function removeWorkspaceFileLinkFromContent(
  content: string,
  path: string
): string {
  const targetPath = path.trim();
  if (!targetPath) {
    return normalizeContentString(content);
  }
  const normalized = normalizeContentString(content);
  const next = normalized
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      const refs = extractWorkspaceFileLinksFromContent(trimmed);
      return !refs.some((ref) => ref.path === targetPath) || refs.length > 1;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return next.trim();
}

export function extractPlainTextFromContent(value?: string | null): string {
  const content = normalizeContentString(value);
  if (!content) {
    return "";
  }
  return content
    .replace(MARKDOWN_IMAGE_PATTERN, " $1 ")
    .replace(MARKDOWN_LINK_PATTERN, " $1 ")
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
  return content
    .replace(MARKDOWN_IMAGE_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, " ")
    .replace(/^[\s>*#+-]+/gm, " ")
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/[*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
