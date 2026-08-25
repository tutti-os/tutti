const PREFERRED_STRUCTURED_TEXT_KEYS = [
  "plan",
  "text",
  "summary",
  "result",
  "output",
  "error",
  "message",
  "detail",
  "details",
  "reason",
  "description",
  "stdout",
  "stderr",
  "query",
  "path",
  "file",
  "filePath",
  "file_path",
  "url",
  "cmd",
  "command",
  "content",
  "data",
  "response",
  "status",
  "account",
  "usage"
] as const;

const MAX_STRUCTURED_TEXT_DEPTH = 5;
const MAX_STRUCTURED_TEXT_ITEMS = 32;
const MAX_STRUCTURED_TEXT_LENGTH = 16_000;

/**
 * Extracts a bounded human-readable value from provider-shaped tool data.
 * Provider error envelopes are not stable across adapters, so this helper
 * intentionally follows a small set of semantic keys instead of serializing
 * arbitrary payloads. Nested provider envelopes are covered by the same keys
 * at each bounded depth.
 */
export function structuredToolText(value: unknown): string | null {
  const text = visitStructuredToolText(value, 0, new WeakSet<object>());
  if (!text) {
    return null;
  }
  return text.length > MAX_STRUCTURED_TEXT_LENGTH
    ? text.slice(0, MAX_STRUCTURED_TEXT_LENGTH)
    : text;
}

function visitStructuredToolText(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (
    !value ||
    typeof value !== "object" ||
    depth > MAX_STRUCTURED_TEXT_DEPTH
  ) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const parts = value
      .slice(0, MAX_STRUCTURED_TEXT_ITEMS)
      .map((entry) => visitStructuredToolText(entry, depth + 1, seen))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  const record = value as Record<string, unknown>;
  for (const key of PREFERRED_STRUCTURED_TEXT_KEYS) {
    const text = visitStructuredToolText(record[key], depth + 1, seen);
    if (text) {
      return text;
    }
  }

  return null;
}
