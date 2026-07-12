/**
 * Strips common markdown formatting markers from text so that copying
 * an agent reply produces clean plain text without stray `**`, `*`,
 * backticks, or similar markup characters.
 */
export function markdownToPlainText(text: string): string {
  let result = text;

  // Fenced code blocks: remove the fence markers, keep the content
  result = result.replace(/```[^\n]*\n?/g, "");
  result = result.replace(/```/g, "");

  // Images: ![alt](url) → alt
  result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Links: [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Bold: **text** → text
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");

  // Bold with underscores: __text__ → text
  result = result.replace(/__(.+?)__/g, "$1");

  // Inline code: `text` → text
  result = result.replace(/`([^`]+)`/g, "$1");

  // Italic: *text* → text
  result = result.replace(/\*([^*\n]+?)\*/g, "$1");

  // Strikethrough: ~~text~~ → text
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Heading markers at line start: "# " or "## " etc.
  result = result.replace(/^#{1,6}\s+/gm, "");

  return result;
}
