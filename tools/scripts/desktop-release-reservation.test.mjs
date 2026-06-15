import assert from "node:assert/strict";
import test from "node:test";

import { claimDesktopRelease } from "../../apps/desktop/scripts/lib/claimDesktopRelease.mjs";

test("claimDesktopRelease retries auto rc releases until a unique tag is reserved", async () => {
  let tags = ["tutti-desktop-v1.12.20"];
  let reserveAttempts = 0;

  const release = await claimDesktopRelease({
    currentVersion: "0.0.0",
    listTags: async () => [...tags],
    reserveTag: async (tag) => {
      reserveAttempts += 1;
      if (reserveAttempts === 1) {
        tags = [...tags, tag];
        return false;
      }
      tags = [...tags, tag];
      return true;
    },
    strategy: "patch_rc"
  });

  assert.equal(release.version, "1.12.21-rc.1");
  assert.equal(release.tag, "v1.12.21-rc.1");
  assert.equal(release.prerelease, true);
  assert.equal(release.makeLatest, false);
  assert.equal(reserveAttempts, 2);
});

test("claimDesktopRelease fails explicit versions when the tag is already reserved", async () => {
  await assert.rejects(
    claimDesktopRelease({
      currentVersion: "0.0.0",
      explicitVersion: "1.12.21-rc.3",
      listTags: async () => ["v1.12.21-rc.3"],
      reserveTag: async () => false,
      strategy: "explicit_version"
    }),
    /Release tag already exists: v1.12.21-rc.3/
  );
});

test("claimDesktopRelease stops after exhausting the reservation retry budget", async () => {
  await assert.rejects(
    claimDesktopRelease({
      currentVersion: "0.0.0",
      listTags: async () => ["tutti-desktop-v1.12.20"],
      maxAttempts: 2,
      reserveTag: async () => false,
      strategy: "patch"
    }),
    /Unable to reserve a unique release tag after 2 attempts/
  );
});
