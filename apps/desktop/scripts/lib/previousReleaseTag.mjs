import { parseReleaseTag } from "./releaseConfig.mjs";

function normalizeVersion(tag) {
  return parseReleaseTag(tag) ?? tag.replace(/^v/u, "");
}

function isPrereleaseVersion(version) {
  return /-[0-9A-Za-z.-]+$/u.test(version);
}

function parseStableCore(version) {
  const match = /^(?<core>\d+\.\d+\.\d+)(?:-(?:rc|beta)\.\d+)?$/u.exec(version);
  return match?.groups?.core ?? "";
}

function resolvePreviousReleaseTag({ channel, tag, tags, version }) {
  const currentTagIndex = tags.indexOf(tag);
  const candidates =
    currentTagIndex === -1
      ? tags.filter((candidate) => candidate !== tag)
      : tags.slice(currentTagIndex + 1);
  if (channel === "stable") {
    return (
      candidates.find(
        (candidate) => !isPrereleaseVersion(normalizeVersion(candidate))
      ) ?? ""
    );
  }

  const stableCore = parseStableCore(version);
  return (
    candidates.find((candidate) => {
      const candidateVersion = normalizeVersion(candidate);
      return (
        candidateVersion.startsWith(`${stableCore}-${channel}.`) &&
        isPrereleaseVersion(candidateVersion)
      );
    }) ??
    candidates.find(
      (candidate) => !isPrereleaseVersion(normalizeVersion(candidate))
    ) ??
    ""
  );
}

export {
  isPrereleaseVersion,
  normalizeVersion,
  parseStableCore,
  resolvePreviousReleaseTag
};
