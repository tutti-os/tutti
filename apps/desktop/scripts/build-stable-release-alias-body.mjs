#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SECTION_START = "<!-- tutti-desktop-stable-release-alias:start -->";
const SECTION_END = "<!-- tutti-desktop-stable-release-alias:end -->";

function normalizeStableRelease(release) {
  const tag = String(release.tagName ?? release.tag_name ?? "").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(
      `Stable release alias requires a stable version tag, got ${tag || "(empty)"}.`
    );
  }

  const url = String(release.url ?? release.html_url ?? "").trim();
  if (!url) {
    throw new Error(`Stable release alias requires a release URL for ${tag}.`);
  }

  return {
    body: String(release.body ?? "").trim(),
    tag,
    url
  };
}

function buildStableReleaseAliasBody(release) {
  const stableRelease = normalizeStableRelease(release);
  const body = [
    SECTION_START,
    "## Stable Desktop Release",
    "",
    `Current stable release: [${stableRelease.tag}](${stableRelease.url})`,
    "",
    "This floating release is refreshed after every desktop release. GitHub Releases is reserved for the recommended stable build; RC and beta downloads are distributed through their preview channels.",
    SECTION_END
  ];

  if (stableRelease.body) {
    body.push("", stableRelease.body);
  }

  return `${body.join("\n")}\n`;
}

async function main() {
  const [releaseJsonPath, outputBodyPath] = process.argv.slice(2);
  if (!releaseJsonPath || !outputBodyPath) {
    throw new Error(
      "Usage: node apps/desktop/scripts/build-stable-release-alias-body.mjs <release-json-path> <output-body-path>"
    );
  }

  const release = JSON.parse(await readFile(releaseJsonPath, "utf8"));
  await writeFile(outputBodyPath, buildStableReleaseAliasBody(release), "utf8");
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
  buildStableReleaseAliasBody,
  normalizeStableRelease
};
