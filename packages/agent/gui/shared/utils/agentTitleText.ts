import { markdownToPlainText } from "../agentConversation/lib/markdownToPlainText";

export function normalizeAgentTitleText(
  value: string | null | undefined
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return markdownToPlainText(trimmed).replace(/\s+/g, " ").trim();
}
