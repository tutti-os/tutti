import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopReleaseFeedResolver,
  normalizeDesktopReleaseFeedBaseUrl,
  resolveDesktopReleasePointerUrl
} from "./desktopReleaseFeed.ts";

const baseUrl = "https://updates.example.test/tutti-desktop-release-assets";

test("desktop release feed resolves the stable pointer to its immutable feed", async () => {
  const requestedUrls: string[] = [];
  const resolver = createDesktopReleaseFeedResolver({
    baseUrl,
    fetch: async (input) => {
      requestedUrls.push(String(input));
      return jsonResponse(createPointerDocument());
    }
  });

  const feed = await resolver({ channel: "stable" });

  assert.deepEqual(requestedUrls, [`${baseUrl}/latest.json`]);
  assert.deepEqual(feed, {
    feedUrl: `${baseUrl}/v1.2.3`,
    releasedAt: "2026-07-13T10:00:00.000Z",
    releaseNotesUrl: null,
    tag: "v1.2.3",
    updaterChannel: "latest",
    version: "1.2.3"
  });
});

test("desktop release feed resolves the RC pointer to rc-mac.yml channel", async () => {
  const resolver = createDesktopReleaseFeedResolver({
    baseUrl,
    fetch: async () =>
      jsonResponse(
        createPointerDocument({
          channel: "rc",
          prerelease: true,
          tag: "v1.2.4-rc.0",
          version: "1.2.4-rc.0"
        })
      )
  });

  const feed = await resolver({ channel: "rc" });

  assert.equal(feed.feedUrl, `${baseUrl}/v1.2.4-rc.0`);
  assert.equal(feed.updaterChannel, "rc");
});

test("desktop release feed rejects malformed pointer JSON", async () => {
  const resolver = createDesktopReleaseFeedResolver({
    baseUrl,
    fetch: async () => new Response("not json", { status: 200 })
  });

  await assert.rejects(resolver({ channel: "stable" }), /not valid JSON/);
});

test("desktop release feed exposes a validated release notes URL", async () => {
  const releaseNotesUrl =
    "https://github.com/tutti-os/tutti/releases/tag/v1.2.3";
  const resolver = createDesktopReleaseFeedResolver({
    baseUrl,
    fetch: async () => jsonResponse(createPointerDocument({ releaseNotesUrl }))
  });

  assert.equal(
    (await resolver({ channel: "stable" })).releaseNotesUrl,
    releaseNotesUrl
  );
});

test("desktop release feed rejects an unsupported schema, origin, channel, and tag", async (t) => {
  const cases = [
    {
      expected: /Unsupported desktop update pointer schema/,
      overrides: { schemaVersion: "tutti.desktop.release.latest.v2" }
    },
    {
      expected: /base URL does not match/,
      overrides: { baseUrl: "https://unexpected.example.test/release-assets" }
    },
    {
      expected: /channel mismatch/,
      overrides: {
        channel: "rc",
        prerelease: true,
        tag: "v1.2.3-rc.0",
        version: "1.2.3-rc.0"
      }
    },
    {
      expected: /tag and version do not match/,
      overrides: { tag: "v1.2.4" }
    }
  ];

  for (const { expected, overrides } of cases) {
    await t.test(expected.source, async () => {
      const resolver = createDesktopReleaseFeedResolver({
        baseUrl,
        fetch: async () => jsonResponse(createPointerDocument(overrides))
      });

      await assert.rejects(resolver({ channel: "stable" }), expected);
    });
  }
});

test("desktop release feed validates HTTPS bases and pointer paths", () => {
  assert.equal(normalizeDesktopReleaseFeedBaseUrl(`${baseUrl}///`), baseUrl);
  assert.equal(
    resolveDesktopReleasePointerUrl({ baseUrl, channel: "stable" }),
    `${baseUrl}/latest.json`
  );
  assert.equal(
    resolveDesktopReleasePointerUrl({ baseUrl, channel: "rc" }),
    `${baseUrl}/channels/rc/latest.json`
  );
  assert.throws(
    () => normalizeDesktopReleaseFeedBaseUrl("http://updates.example.test"),
    /must use HTTPS/
  );
});

function createPointerDocument(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    baseUrl,
    channel: "stable",
    prerelease: false,
    releasedAt: "2026-07-13T10:00:00.000Z",
    schemaVersion: "tutti.desktop.release.latest.v1",
    tag: "v1.2.3",
    version: "1.2.3",
    ...overrides
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}
