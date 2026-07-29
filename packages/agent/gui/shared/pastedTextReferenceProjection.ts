import { createRichTextMentionMarkdown } from "@tutti-os/ui-rich-text/core";
import { AGENT_PASTED_TEXT_MENTION_KIND } from "./pastedTextKinds";

// Matches a landed pasted-text archive path (content-addressed .txt under the
// host's agent-prompt-assets dir). The path may contain spaces (e.g. macOS
// "Application Support"), so match from the leading "/" or drive letter up to
// the first ".txt" after "agent-prompt-assets", staying on one line.
const PASTED_TEXT_ARCHIVE_PATH_RE =
  /(?:\/|[A-Za-z]:\\)[^\n]*?agent-prompt-assets[^\n]*?\.txt/;

export function pastedTextDraftDisplayName(index: number): string {
  return `pasted-text-${index + 1}.txt`;
}

/**
 * Extracts landed pasted-text archive paths from a persisted content text block.
 */
export function extractPastedTextArchivePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const path = firstPastedTextArchivePath(line);
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Rewrites persisted pasted-text instructions into the same mention links the
 * composer emits, without importing the interactive Composer model.
 */
export function linkifyPastedTextReferences(text: string): string {
  if (!PASTED_TEXT_ARCHIVE_PATH_RE.test(text)) {
    return text;
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let refIndex = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const path = firstPastedTextArchivePath(line);
    if (path) {
      out.push(
        pastedTextReferenceMentionMarkdown(
          firstQuotedPreview(line),
          path,
          refIndex
        )
      );
      refIndex += 1;
      continue;
    }
    const next = lines[index + 1];
    if (next != null && firstPastedTextArchivePath(next)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function firstPastedTextArchivePath(line: string): string | null {
  return line.match(PASTED_TEXT_ARCHIVE_PATH_RE)?.[0].trim() ?? null;
}

function pastedTextReferenceMentionMarkdown(
  preview: string,
  path: string,
  index: number
): string {
  return createRichTextMentionMarkdown({
    providerId: AGENT_PASTED_TEXT_MENTION_KIND,
    entityId: `ref-${index}`,
    label: preview.trim() || pastedTextDraftDisplayName(index),
    scope: { path }
  });
}

function firstQuotedPreview(line: string): string {
  return line.match(/"([^"]*)"/)?.[1]?.trim() ?? "";
}
