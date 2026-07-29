import test from "node:test";
import assert from "node:assert/strict";

import {
  GITHUB_RELEASE_BODY_MAX_LENGTH,
  RELEASE_NOTES_TRUNCATION_NOTICE
} from "../../apps/desktop/scripts/lib/githubReleaseBody.mjs";
import {
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody
} from "../../apps/desktop/scripts/upsert-release-download-links.mjs";

test("desktop release notes append all macOS direct download links for mirrored assets", () => {
  const nextBody = buildUpdatedReleaseBody({
    assetNames: [
      "Tutti-0.1.0-rc.2-linux-x86_64.AppImage",
      "Tutti-0.1.0-rc.2-mac-arm64.dmg",
      "Tutti-0.1.0-rc.2-mac-universal.dmg",
      "Tutti-0.1.0-rc.2-mac-x64.dmg",
      "Tutti-0.1.0-rc.2-win-x64.exe"
    ],
    existingBody: "## What's Changed\n- Something",
    releaseAssetBaseUrl:
      "https://d111111abcdef8.cloudfront.net/desktop-release-assets",
    releaseTag: "v0.1.0-rc.2"
  });

  assert.match(
    nextBody,
    new RegExp(SECTION_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.match(nextBody, /### Direct Downloads/);
  assert.match(
    nextBody,
    /\[macOS Apple Silicon \(arm64\)\]\(https:\/\/d111111abcdef8\.cloudfront\.net\/desktop-release-assets\/v0\.1\.0-rc\.2\/Tutti-0\.1\.0-rc\.2-mac-arm64\.dmg\)/
  );
  assert.match(
    nextBody,
    /\[macOS Intel \(x64\)\]\(https:\/\/d111111abcdef8\.cloudfront\.net\/desktop-release-assets\/v0\.1\.0-rc\.2\/Tutti-0\.1\.0-rc\.2-mac-x64\.dmg\)/
  );
  assert.match(
    nextBody,
    /\[macOS Universal\]\(https:\/\/d111111abcdef8\.cloudfront\.net\/desktop-release-assets\/v0\.1\.0-rc\.2\/Tutti-0\.1\.0-rc\.2-mac-universal\.dmg\)/
  );
  assert.doesNotMatch(nextBody, /\[Windows\]/);
  assert.doesNotMatch(nextBody, /\[Linux\]/);
});

test("desktop release notes replace the managed direct download section in place", () => {
  const existingBody = [
    "## What's Changed",
    "",
    SECTION_START,
    "### Direct Downloads",
    "- [macOS](https://old.example/mac.dmg)",
    SECTION_END,
    "",
    "More text"
  ].join("\n");

  const nextBody = buildUpdatedReleaseBody({
    assetNames: ["Tutti-1.0.0-mac-universal.dmg"],
    existingBody,
    releaseAssetBaseUrl: "https://downloads.example.com/tutti",
    releaseTag: "v1.0.0"
  });

  assert.equal(nextBody.match(new RegExp(SECTION_START, "g"))?.length, 1);
  assert.doesNotMatch(nextBody, /old\.example/);
  assert.match(
    nextBody,
    /\[macOS Universal\]\(https:\/\/downloads\.example\.com\/tutti\/v1\.0\.0\/Tutti-1\.0\.0-mac-universal\.dmg\)/
  );
});

test("desktop release notes remove the managed section when no mirrored base URL is configured", () => {
  const existingBody = [
    "## What's Changed",
    "",
    SECTION_START,
    "### Direct Downloads",
    "- [macOS](https://old.example/mac.dmg)",
    SECTION_END,
    "",
    "More text"
  ].join("\n");

  const nextBody = buildUpdatedReleaseBody({
    assetNames: ["Tutti-1.0.0-mac-universal.dmg"],
    existingBody,
    releaseAssetBaseUrl: "",
    releaseTag: "v1.0.0"
  });

  assert.doesNotMatch(nextBody, /Direct Downloads/);
  assert.doesNotMatch(nextBody, /old\.example/);
  assert.match(nextBody, /More text/);
});

test("desktop release notes preserve direct downloads while trimming oversized generated notes", () => {
  const nextBody = buildUpdatedReleaseBody({
    assetNames: ["Tutti-1.0.0-mac-universal.dmg"],
    existingBody: Array.from(
      { length: 2_000 },
      (_, index) => `- generated note ${index}: ${"x".repeat(80)}`
    ).join("\n"),
    releaseAssetBaseUrl: "https://downloads.example.com/tutti",
    releaseTag: "v1.0.0"
  });

  assert.ok(nextBody.length <= GITHUB_RELEASE_BODY_MAX_LENGTH);
  assert.match(nextBody, /generated note 0:/);
  assert.doesNotMatch(nextBody, /generated note 1999:/);
  assert.match(nextBody, /### Direct Downloads/);
  assert.match(nextBody, /Tutti-1\.0\.0-mac-universal\.dmg/);
  assert.ok(nextBody.includes(RELEASE_NOTES_TRUNCATION_NOTICE));
});
