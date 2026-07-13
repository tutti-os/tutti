import test from "node:test";
import assert from "node:assert/strict";

import {
  SECTION_END,
  SECTION_START,
  buildStableReleaseAliasBody,
  normalizeStableRelease
} from "../../apps/desktop/scripts/build-stable-release-alias-body.mjs";

test("desktop stable release alias body points at the concrete stable release", () => {
  const body = buildStableReleaseAliasBody({
    body: "## Release Summary\n\nStable notes",
    name: "v0.1.16",
    tagName: "v0.1.16",
    url: "https://github.com/tutti-os/tutti/releases/tag/v0.1.16"
  });

  assert.match(body, new RegExp(SECTION_START));
  assert.match(body, /## Stable Desktop Release/);
  assert.match(
    body,
    /Current stable release: \[v0\.1\.16\]\(https:\/\/github\.com\/tutti-os\/tutti\/releases\/tag\/v0\.1\.16\)/
  );
  assert.match(
    body,
    /GitHub Releases is reserved for the recommended stable build/
  );
  assert.match(
    body,
    /RC and beta downloads are distributed through their preview channels/
  );
  assert.match(body, new RegExp(SECTION_END));
  assert.match(body, /## Release Summary\n\nStable notes/);
});

test("desktop stable release alias rejects prerelease tags", () => {
  assert.throws(
    () =>
      normalizeStableRelease({
        tagName: "v0.1.17-rc.2",
        url: "https://github.com/tutti-os/tutti/releases/tag/v0.1.17-rc.2"
      }),
    /requires a stable version tag/
  );
});
