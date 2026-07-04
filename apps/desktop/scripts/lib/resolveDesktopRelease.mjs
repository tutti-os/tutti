import {
  normalizeReleaseTag,
  normalizeReleaseVersion,
  parseReleaseTag
} from "./releaseConfig.mjs";

function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function parseReleaseVersion(value) {
  const normalized = normalizeReleaseVersion(value);
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc|beta)\.(0|[1-9]\d*))?$/.exec(
      normalized
    );
  if (!match) {
    return null;
  }

  const channel = match[4] ?? null;
  const prereleaseNumber = match[5] === undefined ? null : Number(match[5]);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: channel === "beta" ? prereleaseNumber : null,
    channel,
    prereleaseNumber,
    rc: channel === "rc" ? prereleaseNumber : null
  };
}

export function formatReleaseVersion(version) {
  const stable = `${version.major}.${version.minor}.${version.patch}`;
  const channel =
    version.channel ?? ((version.rc ?? null) !== null ? "rc" : null);
  const prereleaseNumber =
    version.prereleaseNumber ?? (channel === "rc" ? version.rc : version.beta);
  return channel === null ? stable : `${stable}-${channel}.${prereleaseNumber}`;
}

export function isReleaseCandidateVersion(version) {
  return parseReleaseVersion(formatReleaseVersion(version))?.channel === "rc";
}

function toStableVersion(version) {
  return {
    beta: null,
    channel: null,
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    prereleaseNumber: null,
    rc: null
  };
}

function compareStableVersions(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function bumpStableVersion(currentVersion, strategy) {
  if (
    strategy === "patch" ||
    strategy === "patch_rc" ||
    strategy === "patch_beta"
  ) {
    return {
      beta: null,
      channel: null,
      major: currentVersion.major,
      minor: currentVersion.minor,
      patch: currentVersion.patch + 1,
      prereleaseNumber: null,
      rc: null
    };
  }
  if (
    strategy === "minor" ||
    strategy === "minor_rc" ||
    strategy === "minor_beta"
  ) {
    return {
      beta: null,
      channel: null,
      major: currentVersion.major,
      minor: currentVersion.minor + 1,
      patch: 0,
      prereleaseNumber: null,
      rc: null
    };
  }
  if (
    strategy === "major" ||
    strategy === "major_rc" ||
    strategy === "major_beta"
  ) {
    return {
      beta: null,
      channel: null,
      major: currentVersion.major + 1,
      minor: 0,
      patch: 0,
      prereleaseNumber: null,
      rc: null
    };
  }
  return null;
}

function resolveLatestStableVersion(currentVersion, tags) {
  let latestVersion = toStableVersion(currentVersion);

  for (const tag of tags) {
    const parsedVersion = parseReleaseVersion(tag);
    if (!parsedVersion || parsedVersion.channel !== null) {
      continue;
    }
    if (compareStableVersions(parsedVersion, latestVersion) > 0) {
      latestVersion = toStableVersion(parsedVersion);
    }
  }

  return latestVersion;
}

function resolveNextPrereleaseVersion(baseVersion, tags, channel) {
  let highestPrerelease = -1;

  for (const tag of tags) {
    const parsedVersion = parseReleaseVersion(tag);
    if (
      !parsedVersion ||
      parsedVersion.channel !== channel ||
      compareStableVersions(parsedVersion, baseVersion) !== 0
    ) {
      continue;
    }

    highestPrerelease = Math.max(
      highestPrerelease,
      parsedVersion.prereleaseNumber
    );
  }

  const prereleaseNumber = highestPrerelease + 1;
  return {
    ...baseVersion,
    beta: channel === "beta" ? prereleaseNumber : null,
    channel,
    prereleaseNumber,
    rc: channel === "rc" ? prereleaseNumber : null
  };
}

function resolveNextRcVersion(baseVersion, tags) {
  return resolveNextPrereleaseVersion(baseVersion, tags, "rc");
}

function parseExplicitReleaseTag(tag) {
  const parsedTag = parseReleaseTag(tag);
  return parsedTag ? parseReleaseVersion(parsedTag) : null;
}

export function resolveDesktopRelease({
  currentVersion,
  explicitTag = "",
  explicitVersion = "",
  strategy,
  tags = []
}) {
  const parsedCurrentVersion = parseReleaseVersion(currentVersion);
  if (!parsedCurrentVersion) {
    throw new Error(
      `Unsupported package.json version: ${currentVersion || "(empty)"}`
    );
  }

  let releaseVersion;
  if (
    strategy === "patch" ||
    strategy === "minor" ||
    strategy === "major" ||
    strategy === "patch_rc" ||
    strategy === "minor_rc" ||
    strategy === "major_rc" ||
    strategy === "patch_beta" ||
    strategy === "minor_beta" ||
    strategy === "major_beta"
  ) {
    const latestStableVersion = resolveLatestStableVersion(
      parsedCurrentVersion,
      tags
    );
    const bumpedVersion = bumpStableVersion(latestStableVersion, strategy);
    if (!bumpedVersion) {
      throw new Error(`Unsupported strategy: ${strategy}`);
    }
    if (strategy.endsWith("_rc")) {
      releaseVersion = resolveNextPrereleaseVersion(bumpedVersion, tags, "rc");
    } else if (strategy.endsWith("_beta")) {
      releaseVersion = resolveNextPrereleaseVersion(bumpedVersion, tags, "beta");
    } else {
      releaseVersion = bumpedVersion;
    }
  } else if (strategy === "explicit_version") {
    releaseVersion = parseReleaseVersion(explicitVersion);
    if (!releaseVersion) {
      throw new Error(
        `Invalid release version: ${explicitVersion || "(empty)"}`
      );
    }
  } else if (strategy === "explicit_tag") {
    releaseVersion = parseExplicitReleaseTag(explicitTag);
    if (!releaseVersion) {
      throw new Error(`Invalid release tag: ${explicitTag || "(empty)"}`);
    }
  } else {
    throw new Error(`Unsupported strategy: ${strategy}`);
  }

  const version = formatReleaseVersion(releaseVersion);
  const channel = releaseVersion.channel ?? "stable";
  const prerelease = channel !== "stable";
  return {
    channel,
    makeLatest: !prerelease,
    prerelease,
    tag: normalizeReleaseTag(version),
    version
  };
}

export {
  compareStableVersions,
  parseStableVersion,
  resolveLatestStableVersion,
  resolveNextPrereleaseVersion,
  resolveNextRcVersion
};
