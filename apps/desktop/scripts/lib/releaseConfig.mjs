export const RELEASE_REPO_OWNER = "tutti-os";
export const RELEASE_REPO_NAME = "tutti";
export const LEGACY_RELEASE_TAG_PREFIX = "tutti-desktop-v";
export const RELEASE_TAG_PREFIX = "v";

export function parseReleaseTag(tag) {
  const normalized = typeof tag === "string" ? tag.trim() : "";
  if (
    normalized.startsWith(LEGACY_RELEASE_TAG_PREFIX) &&
    normalized.length > LEGACY_RELEASE_TAG_PREFIX.length
  ) {
    return normalized.slice(LEGACY_RELEASE_TAG_PREFIX.length);
  }

  if (
    normalized.startsWith(RELEASE_TAG_PREFIX) &&
    normalized.length > RELEASE_TAG_PREFIX.length
  ) {
    return normalized.slice(RELEASE_TAG_PREFIX.length);
  }

  return null;
}

export function normalizeReleaseVersion(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  const parsed = parseReleaseTag(normalized);
  if (parsed) {
    return parsed;
  }

  return normalized.startsWith("v") ? normalized.slice(1) : normalized;
}

export function normalizeReleaseTag(value) {
  return `${RELEASE_TAG_PREFIX}${normalizeReleaseVersion(value)}`;
}
