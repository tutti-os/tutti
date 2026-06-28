/**
 * Removes Markdown emphasis markers (`**`, `*`, `__`, `_`) from prose text so
 * that text copied from an agent reply reads as plain text. Inline code spans
 * (`` `code` ``) and fenced code blocks are preserved — their content is
 * meaningful and stripping markers inside would corrupt it.
 */
export function stripMarkdownEmphasis(text: string): string {
  // Split into alternating [prose, code, prose, code, …] segments.
  // The capturing group keeps code spans/blocks in the result array.
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts
    .map((part, i) => {
      // Odd indices are code spans / fenced blocks from the capturing group.
      if (i % 2 === 1) return part;
      return stripEmphasisDelimiters(part);
    })
    .join("");
}

function stripEmphasisDelimiters(prose: string): string {
  return (
    prose
      // ***bold italic*** — strip before ** to avoid partial matches.
      .replace(/\*\*\*(.+?)\*\*\*/gs, "$1")
      // **bold**
      .replace(/\*\*(.+?)\*\*/gs, "$1")
      // *italic* — require non-* on both sides, no newlines inside.
      .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1$2")
      // __bold__
      .replace(/__(.+?)__/gs, "$1")
      // _italic_ — require word boundary on both sides, no newlines inside.
      .replace(/(^|[^_\w])_([^_\n]+?)_(?![\w_])/g, "$1$2")
  );
}
