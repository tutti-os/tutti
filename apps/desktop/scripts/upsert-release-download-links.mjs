#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const SECTION_START = "<!-- tutti-desktop-download-links:start -->";
const SECTION_END = "<!-- tutti-desktop-download-links:end -->";

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeManagedSection(body) {
  const managedSectionPattern = new RegExp(
    `\\n*${escapeRegex(SECTION_START)}[\\s\\S]*?${escapeRegex(SECTION_END)}\\n*`,
    "g"
  );

  return body.replace(managedSectionPattern, "\n").trimEnd();
}

function resolveDesktopDownloadLinks(
  assetNames,
  releaseTag,
  releaseAssetBaseUrl
) {
  const desktopAssets = [
    { label: "macOS", matcher: (name) => /\.dmg$/i.test(name) }
  ];
  const normalizedBaseUrl = normalizeBaseUrl(releaseAssetBaseUrl);

  return desktopAssets
    .map(({ label, matcher }) => {
      const assetName = assetNames.find(matcher);
      if (!assetName) {
        return null;
      }

      const assetUrl = `${normalizedBaseUrl}/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`;
      return `- [${label}](${assetUrl})`;
    })
    .filter(Boolean);
}

function buildUpdatedReleaseBody({
  assetNames,
  existingBody,
  releaseAssetBaseUrl,
  releaseTag
}) {
  const cleanedBody = removeManagedSection(existingBody);

  if (!releaseTag || !releaseAssetBaseUrl) {
    return `${cleanedBody}\n`;
  }

  const directDownloadLinks = resolveDesktopDownloadLinks(
    [...assetNames].sort((left, right) => left.localeCompare(right)),
    releaseTag,
    releaseAssetBaseUrl
  );

  if (directDownloadLinks.length === 0) {
    return `${cleanedBody}\n`;
  }

  return [
    cleanedBody,
    "",
    SECTION_START,
    "### Direct Downloads",
    ...directDownloadLinks,
    SECTION_END,
    ""
  ].join("\n");
}

async function main() {
  const [existingBodyPath, assetDirPath, outputBodyPath] =
    process.argv.slice(2);

  if (!existingBodyPath || !assetDirPath || !outputBodyPath) {
    throw new Error(
      "Usage: node apps/desktop/scripts/upsert-release-download-links.mjs <existing-body-path> <asset-dir> <output-body-path>"
    );
  }

  const releaseTag = (process.env.RELEASE_TAG ?? "").trim();
  const releaseAssetBaseUrl = (process.env.RELEASE_ASSET_BASE_URL ?? "").trim();
  const existingBody = await readFile(existingBodyPath, "utf8");
  const assetNames = (await readdir(assetDirPath)).map((name) =>
    basename(name)
  );
  const nextBody = buildUpdatedReleaseBody({
    assetNames,
    existingBody,
    releaseAssetBaseUrl,
    releaseTag
  });

  await writeFile(outputBodyPath, nextBody, "utf8");
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
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody,
  removeManagedSection,
  resolveDesktopDownloadLinks
};
