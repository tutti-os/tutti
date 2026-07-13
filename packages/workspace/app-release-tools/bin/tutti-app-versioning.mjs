import semver from "semver";

export function requireSemver(value, label, options = {}) {
  const text = String(value ?? "").trim();
  const normalized = options.allowLeadingV ? text.replace(/^v/u, "") : text;
  if (!normalized || semver.valid(normalized) === null) {
    throw new Error(`${label} must be valid SemVer`);
  }
  return normalized;
}

export function compareSemver(left, right) {
  return semver.compare(
    requireSemver(left, "left version", { allowLeadingV: true }),
    requireSemver(right, "right version", { allowLeadingV: true })
  );
}

export function compareReleaseVersions(left, right) {
  const precedence = compareSemver(left.version, right.version);
  if (precedence !== 0) {
    return precedence;
  }

  const publishedAt = comparePublishedAt(left.publishedAt, right.publishedAt);
  if (publishedAt !== 0) {
    return publishedAt;
  }

  return left.version.localeCompare(right.version);
}

export function isTuttiVersionCompatible(minTuttiVersion, tuttiVersion) {
  return compareSemver(minTuttiVersion, tuttiVersion) <= 0;
}

function comparePublishedAt(left, right) {
  const leftTime = Date.parse(String(left ?? ""));
  const rightTime = Date.parse(String(right ?? ""));
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return String(left ?? "").localeCompare(String(right ?? ""));
  }
  return leftTime - rightTime;
}
