import test from "node:test";
import assert from "node:assert/strict";

import {
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody
} from "../../apps/desktop/scripts/upsert-release-download-links.mjs";

test("desktop release notes append only macOS direct download links for mirrored assets", () => {
  const nextBody = buildUpdatedReleaseBody({
    assetNames: [
      "Tutti-0.1.0-rc.2-linux-x86_64.AppImage",
      "Tutti-0.1.0-rc.2-mac-arm64.dmg",
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
    /\[macOS\]\(https:\/\/d111111abcdef8\.cloudfront\.net\/desktop-release-assets\/v0\.1\.0-rc\.2\/Tutti-0\.1\.0-rc\.2-mac-arm64\.dmg\)/
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
    assetNames: ["Tutti-1.0.0-mac-arm64.dmg"],
    existingBody,
    releaseAssetBaseUrl: "https://downloads.example.com/tutti",
    releaseTag: "v1.0.0"
  });

  assert.equal(nextBody.match(new RegExp(SECTION_START, "g"))?.length, 1);
  assert.doesNotMatch(nextBody, /old\.example/);
  assert.match(
    nextBody,
    /\[macOS\]\(https:\/\/downloads\.example\.com\/tutti\/v1\.0\.0\/Tutti-1\.0\.0-mac-arm64\.dmg\)/
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
    assetNames: ["Tutti-1.0.0-mac-arm64.dmg"],
    existingBody,
    releaseAssetBaseUrl: "",
    releaseTag: "v1.0.0"
  });

  assert.doesNotMatch(nextBody, /Direct Downloads/);
  assert.doesNotMatch(nextBody, /old\.example/);
  assert.match(nextBody, /More text/);
});
