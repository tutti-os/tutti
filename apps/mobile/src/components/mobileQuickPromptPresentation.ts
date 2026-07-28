import type { AgentQuickPrompt } from "@tutti-os/client-tuttid-ts";

export interface MobileTextSelection {
  end: number;
  start: number;
}

export function filterMobileQuickPrompts(
  prompts: readonly AgentQuickPrompt[],
  query: string
): readonly AgentQuickPrompt[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return prompts;
  return prompts.filter(
    (prompt) =>
      prompt.title.toLocaleLowerCase().includes(normalizedQuery) ||
      prompt.content.toLocaleLowerCase().includes(normalizedQuery)
  );
}

export function addMobileQuickPrompt(
  draft: string,
  content: string,
  selection: MobileTextSelection | null
): { caret: number; value: string } {
  const fallback = draft.length;
  const insertionPoint = clamp(selection?.end ?? fallback, 0, draft.length);
  return {
    caret: insertionPoint + content.length,
    value: `${draft.slice(0, insertionPoint)}${content}${draft.slice(insertionPoint)}`
  };
}

export function previewMobileQuickPromptContent(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length <= 96 ? compact : `${compact.slice(0, 95)}…`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
