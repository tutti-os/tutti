import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDesktopDistribution,
  resolveDesktopManualDownloadUrl
} from "./desktopDistribution.ts";

test("resolves only a packaged Windows Store process as store distributed", () => {
  assert.equal(
    resolveDesktopDistribution({ platform: "win32", windowsStore: true }),
    "store"
  );
  assert.equal(
    resolveDesktopDistribution({ platform: "win32", windowsStore: false }),
    "direct"
  );
  assert.equal(
    resolveDesktopDistribution({ platform: "darwin", windowsStore: true }),
    "direct"
  );
});

test("uses the Store download contract for Store packages", () => {
  assert.equal(
    resolveDesktopManualDownloadUrl({
      channel: "rc",
      distribution: "store",
      platform: "win32"
    }),
    "https://tutti.sh/desktop/download?channel=stable&platform=windows&arch=x64"
  );
});

test("keeps direct Windows and macOS fallback downloads channel aware", () => {
  assert.equal(
    resolveDesktopManualDownloadUrl({
      channel: "rc",
      distribution: "direct",
      platform: "win32"
    }),
    "https://tutti.sh/desktop/download?channel=rc&platform=windows&arch=x64&distribution=direct&format=exe"
  );
  assert.equal(
    resolveDesktopManualDownloadUrl({
      channel: "rc",
      distribution: "direct",
      platform: "darwin"
    }),
    "https://tutti.sh/desktop/download?channel=preview&platform=macos&arch=universal&format=dmg"
  );
});
