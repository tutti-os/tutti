#!/usr/bin/env node

import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const schemaVersion = "tutti.desktop.release.latest.v1";

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function requireNonEmpty(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function encodeURLPathSegment(value) {
  return encodeURIComponent(value);
}

function releaseVersionFromTag(tag) {
  return tag.replace(/^tutti-desktop-v/, "").replace(/^v/, "");
}

function parseReleaseVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((rc|beta)\.(0|[1-9]\d*)))?$/.exec(
      value
    );
  if (!match) {
    return null;
  }

  return {
    channel: match[5] ?? "stable",
    prerelease: match[4] ?? null,
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`
  };
}

function resolveReleaseChannel(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "stable";
}

function validateReleaseChannel({ channel, parsedVersion, releaseTag }) {
  if (channel === "stable") {
    if (
      parsedVersion.channel === "stable" &&
      parsedVersion.prerelease === null
    ) {
      return false;
    }
    throw new Error(
      `stable latest metadata can only be built for stable releases: ${releaseTag}`
    );
  }

  if (channel === "rc") {
    if (parsedVersion.channel === "rc") {
      return true;
    }
    throw new Error(
      `rc latest metadata can only be built for rc releases: ${releaseTag}`
    );
  }

  if (channel === "beta") {
    if (parsedVersion.channel === "beta") {
      return true;
    }
    throw new Error(
      `beta latest metadata can only be built for beta releases: ${releaseTag}`
    );
  }

  throw new Error(`Unsupported release channel: ${channel}`);
}

function isMacosUniversalDmg(asset) {
  return (
    asset.platform === "macos" &&
    asset.arch === "universal" &&
    asset.format === "dmg"
  );
}

function normalizePlatform(value) {
  const normalized = value.toLowerCase();
  if (
    normalized === "mac" ||
    normalized === "macos" ||
    normalized === "darwin"
  ) {
    return "macos";
  }
  if (normalized === "win" || normalized === "windows") {
    return "windows";
  }
  if (normalized === "linux") {
    return "linux";
  }
  return normalized;
}

function normalizeArch(value) {
  const normalized = value.toLowerCase();
  if (normalized === "x86_64" || normalized === "amd64") {
    return "x64";
  }
  if (normalized === "aarch64") {
    return "arm64";
  }
  return normalized;
}

function classifyDesktopReleaseAsset(name) {
  const format =
    path.extname(name).replace(/^\./, "").toLowerCase() || "unknown";
  const match = name.match(
    /-(mac|macos|darwin|win|windows|linux)-([^.]+)\.[^.]+$/i
  );
  if (!match) {
    return {
      arch: "unknown",
      format,
      platform: "unknown"
    };
  }

  return {
    arch: normalizeArch(match[2]),
    format,
    platform: normalizePlatform(match[1])
  };
}

async function buildDesktopReleaseLatest(options) {
  const assetDirPath = path.resolve(
    requireNonEmpty(options.assetDirPath, "assetDirPath")
  );
  const releaseTag = requireNonEmpty(options.releaseTag, "releaseTag");
  const channel = resolveReleaseChannel(options.channel);
  const releaseVersion = releaseVersionFromTag(releaseTag);
  const parsedVersion = parseReleaseVersion(releaseVersion);
  if (!parsedVersion) {
    throw new Error(`releaseTag must contain a semver version: ${releaseTag}`);
  }
  const prerelease = validateReleaseChannel({
    channel,
    parsedVersion,
    releaseTag
  });
  const baseUrl = normalizeBaseUrl(
    requireNonEmpty(options.releaseAssetBaseUrl, "releaseAssetBaseUrl")
  );
  const gitSha = String(options.gitSha ?? "").trim();
  const sourceRef = String(options.sourceRef ?? "").trim();
  const releasedAt =
    options.releasedAt instanceof Date
      ? options.releasedAt.toISOString()
      : String(options.releasedAt ?? new Date().toISOString()).trim();

  const entries = await readdir(assetDirPath, { withFileTypes: true });
  const assetNames = entries
    .filter((entry) => entry.isFile() && entry.name !== "latest.json")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const assets = [];
  for (const name of assetNames) {
    const fileStat = await stat(path.join(assetDirPath, name));
    const classification = classifyDesktopReleaseAsset(name);
    assets.push({
      ...classification,
      name,
      sizeBytes: fileStat.size,
      url: `${baseUrl}/${encodeURLPathSegment(releaseTag)}/${encodeURLPathSegment(name)}`
    });
  }

  const macosUniversalDmg = assets.find(isMacosUniversalDmg)?.url ?? null;

  return {
    schemaVersion,
    tag: releaseTag,
    version: releaseVersion,
    channel,
    prerelease,
    releasedAt,
    gitSha: gitSha || null,
    sourceRef: sourceRef || null,
    baseUrl,
    preferredDownloads: {
      macosUniversalDmg
    },
    assets
  };
}

async function main() {
  const [assetDirPath, outputPath] = process.argv.slice(2);
  const latest = await buildDesktopReleaseLatest({
    assetDirPath,
    channel: process.env.RELEASE_CHANNEL,
    gitSha: process.env.RELEASE_GIT_SHA,
    releaseAssetBaseUrl: process.env.RELEASE_ASSET_BASE_URL,
    releaseTag: process.env.RELEASE_TAG,
    releasedAt: process.env.RELEASED_AT,
    sourceRef: process.env.RELEASE_SOURCE_REF
  });

  await writeFile(
    path.resolve(requireNonEmpty(outputPath, "outputPath")),
    `${JSON.stringify(latest, null, 2)}\n`,
    "utf8"
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  buildDesktopReleaseLatest,
  classifyDesktopReleaseAsset,
  normalizeBaseUrl,
  parseReleaseVersion,
  releaseVersionFromTag,
  resolveReleaseChannel,
  schemaVersion
};
