import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubPrefixedDesktopReleaseResolver,
  parseDesktopVersion,
  stripDesktopReleaseTagPrefix
} from "./prefixedDesktopReleaseResolver.ts";

test("stripDesktopReleaseTagPrefix removes the desktop tag prefix", () => {
  assert.equal(
    stripDesktopReleaseTagPrefix("tutti-desktop-v0.0.1-rc.18"),
    "0.0.1-rc.18"
  );
});

test("parseDesktopVersion accepts prefixed desktop release tags", () => {
  assert.deepEqual(parseDesktopVersion("tutti-desktop-v0.0.1-rc.18"), {
    major: 0,
    minor: 0,
    patch: 1,
    prerelease: ["rc", 18]
  });
});

test("createGitHubPrefixedDesktopReleaseResolver reads prefixed releases from Atom feed", async () => {
  const fetch = async () =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <updated>2026-06-15T10:07:43Z</updated>
          <link rel="alternate" type="text/html" href="https://github.com/tutti-os/tutti/releases/tag/tutti-desktop-v0.0.1"/>
          <title>tutti-desktop-v0.0.1</title>
        </entry>
        <entry>
          <updated>2026-06-15T06:44:16Z</updated>
          <link rel="alternate" type="text/html" href="https://github.com/tutti-os/tutti/releases/tag/tutti-desktop-v0.0.1-rc.18"/>
          <title>tutti-desktop-v0.0.1-rc.18</title>
        </entry>
        <entry>
          <updated>2026-06-14T06:44:16Z</updated>
          <link rel="alternate" type="text/html" href="https://github.com/tutti-os/tutti/releases/tag/packages-v0.0.11"/>
          <title>packages-v0.0.11</title>
        </entry>
      </feed>`,
      {
        status: 200
      }
    );
  const resolver = createGitHubPrefixedDesktopReleaseResolver({ fetch });

  const release = await resolver({
    channel: "rc",
    currentVersion: "0.0.1-rc.17"
  });

  assert.deepEqual(release, {
    htmlUrl:
      "https://github.com/tutti-os/tutti/releases/tag/tutti-desktop-v0.0.1-rc.18",
    name: "tutti-desktop-v0.0.1-rc.18",
    publishedAt: "2026-06-15T06:44:16Z",
    tagName: "tutti-desktop-v0.0.1-rc.18",
    version: "0.0.1-rc.18"
  });
});
