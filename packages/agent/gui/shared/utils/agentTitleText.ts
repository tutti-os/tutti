const markdownLinkPattern = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;
const markdownLabelEscapePattern = /\\([\\[\]()])/g;
const markdownBoldAsteriskPattern = /\*\*(.+?)\*\*/g;
const markdownBoldUnderscorePattern = /__(.+?)__/g;
const markdownItalicAsteriskPattern = /\*([^\s*][^*]*?)\*/g;
const markdownItalicUnderscorePattern = /_([^\s_][^_]*?)_/g;

export function normalizeAgentTitleText(
  value: string | null | undefined
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const withoutLinks = trimmed.replace(
    markdownLinkPattern,
    (_, label: string) => unescapeMarkdownLabel(label)
  );
  const withoutEmphasis = withoutLinks
    .replace(markdownBoldAsteriskPattern, "$1")
    .replace(markdownBoldUnderscorePattern, "$1")
    .replace(markdownItalicAsteriskPattern, "$1")
    .replace(markdownItalicUnderscorePattern, "$1");
  return withoutEmphasis.replace(/\s+/g, " ").trim();
}

function unescapeMarkdownLabel(label: string): string {
  return label.replace(markdownLabelEscapePattern, "$1");
}
