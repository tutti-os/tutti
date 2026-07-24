import { compactText } from "./agentMentionSearchHelpers";

export function normalizeMentionFileRelativePath(
  value: string,
  fileName: string
): string | undefined {
  const normalized = compactText(value)
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized.split("/").at(-1) === fileName ? normalized : undefined;
}

export function normalizeMentionDirectoryChildCount(
  value: number | null | undefined
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function dirnameFromProviderWorkspaceFileHref(href: string): string {
  const normalized = href.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
