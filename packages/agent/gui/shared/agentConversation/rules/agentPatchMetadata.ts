export type AgentPatchChangeType = "created" | "modified" | "deleted";

export function normalizeAgentPatchText(text: string): string {
  if (!text) {
    return text;
  }
  const contentField = tryExtractContentField(text);
  if (contentField) {
    return normalizeAgentPatchText(contentField);
  }
  const expanded =
    !text.includes("\n") && text.includes("\\n")
      ? text.replace(/\\n/g, "\n")
      : text;
  return expanded
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line.trimStart() === "\\ No newline at end of file"
        ? "\\ No newline at end of file"
        : line
    )
    .join("\n");
}

export function extractAgentPatchPath(patchText: string | null): string | null {
  const normalized = normalizeAgentPatchText(patchText ?? "");
  if (!normalized.trim()) {
    return null;
  }

  const applyPatchPath = extractApplyPatchPath(normalized);
  if (applyPatchPath) {
    return applyPatchPath;
  }

  const changeType = inferAgentPatchChangeType(normalized);
  const gitHeader = normalized.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  const oldPath = gitHeader?.[1]?.trim() ?? null;
  const newPath = gitHeader?.[2]?.trim() ?? null;
  if (oldPath || newPath) {
    return changeType === "deleted"
      ? (nonNullPath(oldPath) ?? nonNullPath(newPath))
      : (nonNullPath(newPath) ?? nonNullPath(oldPath));
  }

  if (changeType === "deleted") {
    return extractOldHeaderPath(normalized);
  }
  return extractNewHeaderPath(normalized);
}

export function inferAgentPatchChangeType(
  patchText: string | null
): AgentPatchChangeType {
  const normalized = normalizeAgentPatchText(patchText ?? "").trim();
  if (!normalized) {
    return "modified";
  }
  if (
    /^(\*\*\* Delete File:|deleted file mode\b|\+\+\+ \/dev\/null$)/m.test(
      normalized
    )
  ) {
    return "deleted";
  }
  if (
    /^(\*\*\* Add File:|new file mode\b|--- \/dev\/null$)/m.test(normalized)
  ) {
    return "created";
  }
  return "modified";
}

function extractApplyPatchPath(text: string): string | null {
  const match = text.match(/^\*\*\* (?:Add|Delete|Update) File:\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || null;
}

function extractOldHeaderPath(text: string): string | null {
  const match = text.match(/^---\s+(?:a\/)?([^\n]+)$/m);
  return nonNullPath(match?.[1]?.trim() ?? null);
}

function extractNewHeaderPath(text: string): string | null {
  const match = text.match(/^\+\+\+\s+(?:b\/)?([^\n]+)$/m);
  return nonNullPath(match?.[1]?.trim() ?? null);
}

function nonNullPath(path: string | null): string | null {
  if (!path || path === "/dev/null" || path === "dev/null") {
    return null;
  }
  return path;
}

function tryExtractContentField(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { content?: unknown }).content === "string"
    ) {
      return (parsed as { content: string }).content;
    }
    return null;
  } catch {
    return null;
  }
}
