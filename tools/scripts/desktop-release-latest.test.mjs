import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildDesktopReleaseLatest } from "../../apps/desktop/scripts/build-release-latest.mjs";

test("desktop release latest metadata exposes CloudFront URLs for every asset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-latest-"));
  try {
    await writeFile(path.join(dir, "Tutti-1.2.3-mac-arm64.dmg"), "arm");
    await writeFile(path.join(dir, "Tutti-1.2.3-mac-universal.dmg"), "uni");
    await writeFile(path.join(dir, "Tutti-1.2.3-mac-x64.dmg"), "x64");
    await writeFile(path.join(dir, "Tutti-1.2.3-win-x64.exe"), "win");
    await writeFile(path.join(dir, "latest.json"), "{}");

    const latest = await buildDesktopReleaseLatest({
      assetDirPath: dir,
      gitSha: "537327a1",
      releaseAssetBaseUrl:
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/",
      releaseTag: "v1.2.3",
      releasedAt: "2026-07-04T12:00:00.000Z",
      sourceRef: "main"
    });

    assert.equal(latest.schemaVersion, "tutti.desktop.release.latest.v1");
    assert.equal(latest.tag, "v1.2.3");
    assert.equal(latest.version, "1.2.3");
    assert.equal(latest.channel, "stable");
    assert.equal(latest.prerelease, false);
    assert.equal(latest.releasedAt, "2026-07-04T12:00:00.000Z");
    assert.equal(latest.gitSha, "537327a1");
    assert.equal(latest.sourceRef, "main");
    assert.equal(
      latest.baseUrl,
      "https://d111111abcdef8.cloudfront.net/desktop-release-assets"
    );
    assert.deepEqual(
      latest.assets.map((asset) => asset.name),
      [
        "Tutti-1.2.3-mac-arm64.dmg",
        "Tutti-1.2.3-mac-universal.dmg",
        "Tutti-1.2.3-mac-x64.dmg",
        "Tutti-1.2.3-win-x64.exe"
      ]
    );
    assert.deepEqual(
      latest.assets.map((asset) => ({
        arch: asset.arch,
        format: asset.format,
        platform: asset.platform
      })),
      [
        { arch: "arm64", format: "dmg", platform: "macos" },
        { arch: "universal", format: "dmg", platform: "macos" },
        { arch: "x64", format: "dmg", platform: "macos" },
        { arch: "x64", format: "exe", platform: "windows" }
      ]
    );
    assert.deepEqual(
      latest.assets.map((asset) => asset.url),
      [
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/v1.2.3/Tutti-1.2.3-mac-arm64.dmg",
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/v1.2.3/Tutti-1.2.3-mac-universal.dmg",
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/v1.2.3/Tutti-1.2.3-mac-x64.dmg",
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/v1.2.3/Tutti-1.2.3-win-x64.exe"
      ]
    );
    assert.deepEqual(latest.preferredDownloads, {
      macosUniversalDmg:
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/v1.2.3/Tutti-1.2.3-mac-universal.dmg"
    });
    assert.ok(latest.assets.every((asset) => !("cdnUrl" in asset)));
    assert.equal(latest.downloads, undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("desktop release latest metadata rejects prerelease tags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-latest-"));
  try {
    await writeFile(path.join(dir, "Tutti-1.2.3-rc.1-mac-universal.dmg"), "uni");

    await assert.rejects(
      () =>
        buildDesktopReleaseLatest({
          assetDirPath: dir,
          releaseAssetBaseUrl:
            "https://d111111abcdef8.cloudfront.net/desktop-release-assets/",
          releaseTag: "v1.2.3-rc.1"
        }),
      /latest metadata can only be built for stable releases/
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("desktop release latest metadata supports rc channel tags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-latest-"));
  try {
    await writeFile(path.join(dir, "Tutti-1.2.3-rc.1-mac-universal.dmg"), "uni");

    const latest = await buildDesktopReleaseLatest({
      assetDirPath: dir,
      channel: "rc",
      releaseAssetBaseUrl:
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/",
      releaseTag: "v1.2.3-rc.1"
    });

    assert.equal(latest.channel, "rc");
    assert.equal(latest.prerelease, true);
    assert.equal(latest.version, "1.2.3-rc.1");
    assert.equal(
      latest.preferredDownloads.macosUniversalDmg?.includes("v1.2.3-rc.1"),
      true
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("desktop release latest metadata rejects beta tags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-latest-"));
  try {
    await writeFile(
      path.join(dir, "Tutti-1.2.3-beta.1-mac-universal.dmg"),
      "uni"
    );

    await assert.rejects(
      () =>
        buildDesktopReleaseLatest({
          assetDirPath: dir,
          releaseAssetBaseUrl:
            "https://d111111abcdef8.cloudfront.net/desktop-release-assets/",
          releaseTag: "v1.2.3-beta.1"
        }),
      /latest metadata can only be built for stable releases/
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("desktop release latest metadata supports beta channel tags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-latest-"));
  try {
    await writeFile(
      path.join(dir, "Tutti-1.2.3-beta.1-mac-universal.dmg"),
      "uni"
    );

    const latest = await buildDesktopReleaseLatest({
      assetDirPath: dir,
      channel: "beta",
      releaseAssetBaseUrl:
        "https://d111111abcdef8.cloudfront.net/desktop-release-assets/",
      releaseTag: "v1.2.3-beta.1"
    });

    assert.equal(latest.channel, "beta");
    assert.equal(latest.prerelease, true);
    assert.equal(latest.version, "1.2.3-beta.1");
    assert.equal(
      latest.preferredDownloads.macosUniversalDmg?.includes("v1.2.3-beta.1"),
      true
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
