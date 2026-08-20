#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function resolveUploadUrl(template, assetName) {
  const url = new URL(template.replace(/\{.*$/, ""));
  url.searchParams.set("name", assetName);
  return url;
}

async function uploadReleaseAssets({
  releasePath,
  assetsDirectory,
  token,
  fetchImpl = fetch
}) {
  if (!token) throw new Error("GH_TOKEN is required to upload release assets");

  const release = JSON.parse(await readFile(releasePath, "utf8"));
  if (!release.id || typeof release.upload_url !== "string") {
    throw new Error("GitHub release response is missing id or upload_url");
  }

  const entries = await readdir(assetsDirectory, { withFileTypes: true });
  const assetNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (assetNames.length === 0) {
    throw new Error(`No release assets found in ${assetsDirectory}`);
  }

  for (const assetName of assetNames) {
    const assetPath = path.join(assetsDirectory, assetName);
    const assetStat = await stat(assetPath);
    const uploadUrl = resolveUploadUrl(release.upload_url, assetName);
    const response = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Length": String(assetStat.size),
        "Content-Type": "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: createReadStream(assetPath),
      duplex: "half"
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        `Failed to upload ${assetName} to GitHub release ${release.id}: ${response.status}${detail ? ` ${detail}` : ""}`
      );
    }
    console.log(`Uploaded ${assetName} to GitHub release ${release.id}`);
  }

  return { releaseId: String(release.id), assetNames };
}

async function main() {
  const [releasePath, assetsDirectory] = process.argv.slice(2);
  if (!releasePath || !assetsDirectory) {
    throw new Error(
      "Usage: upload-github-release-assets.mjs <release-json> <assets-directory>"
    );
  }
  await uploadReleaseAssets({
    releasePath,
    assetsDirectory,
    token: process.env.GH_TOKEN
  });
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

export { resolveUploadUrl, uploadReleaseAssets };
