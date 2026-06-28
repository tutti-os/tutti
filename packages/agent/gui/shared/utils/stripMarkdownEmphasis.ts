/**
 * Strips common Markdown emphasis markers from text, leaving the inner
 * content intact.  This is used when a Markdown string needs to be shown
 * as plain text (e.g. clipboard copy, truncated previews) where the raw
 * `**`, `*`, `__`, `_`, `~~` or backtick delimiters would otherwise appear
 * as stray characters.
 *
 * Only **paired** delimiters are removed; lone markers are left untouched
 * so that text which happens to contain asterisks (e.g. `5 * 3`) is not
 * mangled.
 */
export function stripMarkdownEmphasis(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}
