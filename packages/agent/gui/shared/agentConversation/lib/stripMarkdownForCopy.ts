/**
 * Strips markdown formatting markers from text so that copying an agent
 * message produces clean plain text without stray `**`, `*`, `__`, etc.
 *
 * Only formatting markers are removed — link labels are kept, code spans
 * are unwrapped, and list/heading markers are stripped. The goal is a
 * readable plain-text representation, not a full markdown-to-text engine.
 */
export function stripMarkdownForCopy(markdown: string): string {
  let result = markdown;

  // Fenced code blocks: ```\n...\n```  →  keep inner text, drop fences
  result = result.replace(/```+[^\n]*\n?/g, "");

  // Images: ![alt](url)  →  alt
  result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Links: [label](url)  →  label
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Bold + italic: ***text***  →  text
  result = result.replace(/\*{3}(.+?)\*{3}/g, "$1");
  // Bold: **text**  →  text
  result = result.replace(/\*{2}(.+?)\*{2}/g, "$1");
  // Bold alt: __text__  →  text
  result = result.replace(/_{2}(.+?)_{2}/g, "$1");

  // Strikethrough: ~~text~~  →  text
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Inline code: `text`  →  text
  result = result.replace(/`{1,2}([^`]+)`{1,2}/g, "$1");

  // Italic: *text*  →  text  (require non-space after opening * to avoid list bullets)
  result = result.replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, "$1");
  // Italic alt: _text_  →  text  (avoid matching word-internal underscores)
  result = result.replace(/(?<![\w/])_([^_\n]+)_(?![\w/])/g, "$1");

  // Headings: # / ## / ### ...  →  strip leading markers
  result = result.replace(/^#{1,6}\s+/gm, "");

  // List markers: - / * / + / 1.  at line start  →  strip
  result = result.replace(/^\s*[-*+]\s+/gm, "");
  result = result.replace(/^\s*\d+\.\s+/gm, "");

  // Blockquotes: > text  →  text
  result = result.replace(/^\s*>\s?/gm, "");

  // Horizontal rules: --- / *** / ___  →  remove
  result = result.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");

  return result;
}
