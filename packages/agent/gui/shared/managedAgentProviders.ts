export function normalizeManagedAgentProvider(
  provider: string | undefined
): string {
  const normalized =
    provider
      ?.trim()
      .toLowerCase()
      .replace(/[_\s]+/gu, "-") ?? "";
  switch (normalized) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "nexight":
    case "tutti-doc":
    case "tutti-agent":
      return "tutti";
    default:
      return normalized;
  }
}
