import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDesktopGitDescribeVersion,
  resolveDesktopBuildVersion
} from "../../apps/desktop/scripts/lib/desktopBuildVersion.mjs";

test("normalizes exact desktop release tags for electron-builder", () => {
  assert.equal(normalizeDesktopGitDescribeVersion("v1.2.3"), "1.2.3");
  assert.equal(normalizeDesktopGitDescribeVersion("v1.2.3-rc.4"), "1.2.3-rc.4");
  assert.equal(
    normalizeDesktopGitDescribeVersion("tutti-desktop-v1.2.3"),
    "1.2.3"
  );
  assert.equal(
    normalizeDesktopGitDescribeVersion("tutti-desktop-v1.2.3-rc.4"),
    "1.2.3-rc.4"
  );
});

test("normalizes git describe output after a desktop release tag", () => {
  assert.equal(
    normalizeDesktopGitDescribeVersion("v1.2.3-4-gabcdef12"),
    "1.2.3-4-gabcdef12"
  );
  assert.equal(
    normalizeDesktopGitDescribeVersion(
      "tutti-desktop-v1.2.3-rc.4-5-gabcdef12-dirty"
    ),
    "1.2.3-rc.4-5-gabcdef12-dirty"
  );
});

test("normalizes hash-only git describe output into semver prerelease", () => {
  assert.equal(
    normalizeDesktopGitDescribeVersion("abcdef12"),
    "0.0.0-abcdef12"
  );
});

test("prefers explicit release tag over git describe output", () => {
  const version = resolveDesktopBuildVersion({
    releaseTag: "v2.0.0",
    describeVersion: "tutti-desktop-v1.9.9-2-gabcdef12"
  });

  assert.equal(version, "2.0.0");
});
