import type { AgentComposerSettingsMenuLabels } from "./composerSettingsMenuModel";

// Pure text presentation for provider model descriptions: display-label
// formatting plus the loose "context window / effort / speed" parsing the
// model menu uses for option summaries and tooltips. Extracted from
// composerSettingsMenuModel.ts so the menu model stays within the business
// file budget; behavior is unchanged.

export function parseModelDescription(description: string): {
  body: string;
  contextWindow?: { summary: string };
  effort?: { summaryValue: string; version: string };
  speed?: "fast";
  title?: string;
} {
  const parts = description
    .split(/[·•\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const firstPart = parts[0] ?? description.trim();
  const contextWindow = contextWindowSummaryFromText(description);
  const effort = effortFromText(description);
  const speed = speedFromText(description);
  const title = titleFromDescriptionPrefix(firstPart, contextWindow?.raw);
  const bodyParts = (title ? parts.slice(1) : parts).filter(
    (part) => !effortFromText(part)
  );
  return {
    body: bodyParts.join(" · "),
    ...(contextWindow
      ? { contextWindow: { summary: contextWindow.summary } }
      : {}),
    ...(effort ? { effort } : {}),
    ...(speed ? { speed } : {}),
    ...(title ? { title } : {})
  };
}

function contextWindowSummaryFromText(
  text: string
): { raw: string; summary: string } | null {
  const match = text.match(
    /\b(\d+(?:\.\d+)?\s*[kKmM])\s+(?:token\s+)?context(?:\s+window)?\b/
  );
  if (!match?.[1]) {
    return null;
  }
  return {
    raw: match[0],
    summary: match[1].replace(/\s+/g, "").toUpperCase()
  };
}

function titleFromDescriptionPrefix(
  firstPart: string,
  contextText: string | undefined
): string | undefined {
  if (contextText) {
    const contextIndex = firstPart
      .toLowerCase()
      .indexOf(contextText.toLowerCase());
    if (contextIndex > 0) {
      const title = firstPart
        .slice(0, contextIndex)
        .replace(/\bwith\s*$/i, "")
        .trim();
      return title ? formatModelDisplayLabel(title) : undefined;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9 ._-]*\d(?:[A-Za-z0-9 ._-]*)?$/.test(firstPart)) {
    return formatModelDisplayLabel(firstPart);
  }
  return undefined;
}

function effortFromText(
  text: string
): { summaryValue: string; version: string } | undefined {
  const effortMatch = text
    .toLowerCase()
    .match(/\b(minimal|low|medium|high|x[-\s]?high|max|ultra)\s+effort\b/);
  if (!effortMatch?.[1]) {
    return undefined;
  }
  return {
    summaryValue: effortMatch[1].replace(/\s+/g, "").replace("-", ""),
    version: effortMatch[0]
  };
}

function speedFromText(text: string): "fast" | undefined {
  return /\bfast\b/i.test(text) ? "fast" : undefined;
}

export function formatModelDisplayLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return label;
  }
  const capitalized = trimmed.replace(
    /(^|[^A-Za-z0-9])([A-Za-z])/g,
    (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`
  );
  return capitalized.replace(/gpt/gi, "GPT");
}

export function shortModelDisplayLabel(label: string): string {
  const formatted = formatModelDisplayLabel(label.replace(/\([^)]*\)/g, ""));
  const family = formatted.trim().split(/\s+/)[0];
  switch (family?.toLowerCase()) {
    case "default":
    case "opus":
    case "sonnet":
    case "haiku":
      return family;
    default:
      return formatted.trim() || label;
  }
}

export function resolveModelDescription(
  description: string | undefined,
  labels: Pick<AgentComposerSettingsMenuLabels, "modelDescriptions">
): string | undefined {
  switch (description) {
    case "Frontier model for complex coding, research, and real-world work.":
      return labels.modelDescriptions.frontierComplexCoding;
    case "Strong model for everyday coding.":
      return labels.modelDescriptions.everydayCoding;
    case "Small, fast, and cost-efficient model for simpler coding tasks.":
      return labels.modelDescriptions.smallFastCostEfficient;
    case "Coding-optimized model.":
      return labels.modelDescriptions.codingOptimized;
    case "Ultra-fast coding model.":
      return labels.modelDescriptions.ultraFastCoding;
    case "Optimized for professional work and long-running agents.":
      return labels.modelDescriptions.professionalLongRunning;
    default:
      return description;
  }
}
