import { compactText } from "./agentMentionSearchHelpers";

interface MentionFilePathCandidate {
  kind: string;
  name?: string;
  relativePath?: string | null;
}

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
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized.split("/").at(-1) === fileName ? normalized : undefined;
}

export function mentionFileDisambiguationPrefixSegments(
  item: MentionFilePathCandidate & { kind: "file"; name: string },
  candidates: readonly MentionFilePathCandidate[]
): number | undefined {
  const relativePath = normalizeMentionFileRelativePath(
    item.relativePath ?? "",
    item.name
  );
  if (!relativePath) {
    return undefined;
  }
  const directories = relativePath.split("/").slice(0, -1);
  const sameNameDirectories = candidates.flatMap((candidate) => {
    if (candidate === item || candidate.kind !== "file") {
      return [];
    }
    const candidateName = candidate.name ?? "";
    if (candidateName !== item.name) {
      return [];
    }
    const candidatePath = normalizeMentionFileRelativePath(
      candidate.relativePath ?? "",
      candidateName
    );
    return candidatePath ? [candidatePath.split("/").slice(0, -1)] : [];
  });
  if (sameNameDirectories.length === 0) {
    return undefined;
  }
  for (let count = 1; count <= directories.length; count += 1) {
    const prefix = directories.slice(0, count).join("/");
    if (
      sameNameDirectories.every(
        (candidate) => candidate.slice(0, count).join("/") !== prefix
      )
    ) {
      return count;
    }
  }
  return directories.length;
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
