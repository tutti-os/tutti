/**
 * Strips common Markdown formatting markers from a string, returning plain text
 * suitable for clipboard copy or non-rendered preview contexts.
 *
 * Handles: bold/italic (**, *, __, _), inline code (`), strikethrough (~~),
 * links ([text](url) → text), images (![alt](url) → alt), headings (#),
 * and list markers (-, *, +, digit.).
 */
export function stripMarkdownFormatting(markdown: string): string {
  let result = markdown;

  // Remove images: ![alt text](url) → alt text
  result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Remove links: [text](url) → text
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Remove bold+italic combos first: ***text*** or ___text___
  result = result.replace(/\*{3}(.+?)\*{3}/g, "$1");
  result = result.replace(/_{3}(.+?)_{3}/g, "$1");

  // Remove bold: **text** or __text__
  result = result.replace(/\*{2}(.+?)\*{2}/g, "$1");
  result = result.replace(/_{2}(.+?)_{2}/g, "$1");

  // Remove strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "$1");

  // Remove inline code: `code` (including multi-backtick)
  result = result.replace(/`{1,}([^`]+)`{1,}/g, "$1");

  // Remove italic: *text* or _text_
  // Use word-boundary-aware regex to avoid stripping valid underscores in paths
  result = result.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1");
  result = result.replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1");

  // Remove heading markers: # ## ### etc. at line start
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Remove list markers at line start: -, *, +, digit.
  result = result.replace(/^\s*[-*+]\s+/gm, "");
  result = result.replace(/^\s*\d+\.\s+/gm, "");

  // Remove blockquote markers: >
  result = result.replace(/^\s*>\s?/gm, "");

  // Remove horizontal rules: ---, ***, ___
  result = result.replace(/^\s*[-*_]{3,}\s*$/gm, "");

  return result;
}
