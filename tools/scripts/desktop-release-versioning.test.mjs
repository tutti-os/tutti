import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopRelease } from "../../apps/desktop/scripts/lib/resolveDesktopRelease.mjs";

test("stable releases stay latest and are not prereleases", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    explicitVersion: "1.12.20",
    strategy: "explicit_version",
    tags: []
  });

  assert.deepEqual(release, {
    channel: "stable",
    makeLatest: true,
    prerelease: false,
    tag: "v1.12.20",
    version: "1.12.20"
  });
});

test("rc releases are marked as prereleases and do not become latest", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    explicitVersion: "1.12.19-rc.0",
    strategy: "explicit_version",
    tags: []
  });

  assert.deepEqual(release, {
    channel: "rc",
    makeLatest: false,
    prerelease: true,
    tag: "v1.12.19-rc.0",
    version: "1.12.19-rc.0"
  });
});

test("patch rc releases increment the rc number for the next stable version", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    strategy: "patch_rc",
    tags: [
      "tutti-desktop-v1.12.20",
      "tutti-desktop-v1.12.21-rc.0",
      "tutti-desktop-v1.12.21-rc.1"
    ]
  });

  assert.deepEqual(release, {
    channel: "rc",
    makeLatest: false,
    prerelease: true,
    tag: "v1.12.21-rc.2",
    version: "1.12.21-rc.2"
  });
});

test("stable patch releases ignore rc tags when resolving the next latest release", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    strategy: "patch",
    tags: [
      "tutti-desktop-v1.12.20",
      "tutti-desktop-v1.12.21-rc.0",
      "tutti-desktop-v1.12.21-rc.1"
    ]
  });

  assert.deepEqual(release, {
    channel: "stable",
    makeLatest: true,
    prerelease: false,
    tag: "v1.12.21",
    version: "1.12.21"
  });
});

test("beta releases are marked as prereleases and do not become latest", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    explicitVersion: "1.12.22-beta.0",
    strategy: "explicit_version",
    tags: []
  });

  assert.deepEqual(release, {
    channel: "beta",
    makeLatest: false,
    prerelease: true,
    tag: "v1.12.22-beta.0",
    version: "1.12.22-beta.0"
  });
});

test("patch beta releases increment the beta number without touching rc tags", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    strategy: "patch_beta",
    tags: [
      "tutti-desktop-v1.12.20",
      "tutti-desktop-v1.12.21-beta.0",
      "tutti-desktop-v1.12.21-beta.1",
      "tutti-desktop-v1.12.21-rc.0"
    ]
  });

  assert.deepEqual(release, {
    channel: "beta",
    makeLatest: false,
    prerelease: true,
    tag: "v1.12.21-beta.2",
    version: "1.12.21-beta.2"
  });
});

test("stable patch releases ignore beta tags when resolving the next latest release", () => {
  const release = resolveDesktopRelease({
    currentVersion: "0.0.0",
    strategy: "patch",
    tags: [
      "tutti-desktop-v1.12.20",
      "tutti-desktop-v1.12.21-beta.0",
      "tutti-desktop-v1.12.21-rc.0"
    ]
  });

  assert.deepEqual(release, {
    channel: "stable",
    makeLatest: true,
    prerelease: false,
    tag: "v1.12.21",
    version: "1.12.21"
  });
});
