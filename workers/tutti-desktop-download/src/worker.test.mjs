import test from "node:test";
import assert from "node:assert/strict";

import { handleDesktopDownloadRequest } from "./worker.mjs";

const baseUrl = "https://downloads.example.com/desktop-release-assets";

function createMetadata(overrides = {}) {
  return {
    schemaVersion: "tutti.desktop.release.latest.v1",
    tag: "v1.2.3",
    version: "1.2.3",
    channel: "stable",
    prerelease: false,
    baseUrl,
    preferredDownloads: {
      macosUniversalDmg: `${baseUrl}/v1.2.3/Tutti-1.2.3-mac-universal.dmg`
    },
    assets: [
      {
        name: "Tutti-1.2.3-mac-universal.dmg",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        url: `${baseUrl}/v1.2.3/Tutti-1.2.3-mac-universal.dmg`
      },
      {
        name: "Tutti-1.2.3-mac-arm64.dmg",
        platform: "macos",
        arch: "arm64",
        format: "dmg",
        url: `${baseUrl}/v1.2.3/Tutti-1.2.3-mac-arm64.dmg`
      }
    ],
    ...overrides
  };
}

function createFetch(metadataByPath, options = {}) {
  const requests = [];
  const analyticsRequests = [];
  const fetchImpl = async (url, init = undefined) => {
    const request = url instanceof Request ? url : new Request(url, init);
    const parsed = new URL(request.url);
    if (parsed.pathname === "/sdk/log") {
      analyticsRequests.push({
        body: await request.json(),
        headers: Object.fromEntries(request.headers.entries()),
        url: parsed.href
      });
      if (options.analyticsStatus && options.analyticsStatus >= 400) {
        return new Response("analytics failed", {
          status: options.analyticsStatus
        });
      }
      return Response.json({ ok: true });
    }

    requests.push(request.url);
    const metadata = metadataByPath[`${parsed.host}${parsed.pathname}`] ?? metadataByPath[parsed.pathname];
    if (!metadata) {
      return new Response("not found", { status: 404 });
    }
    return Response.json(metadata);
  };
  fetchImpl.requests = requests;
  fetchImpl.analyticsRequests = analyticsRequests;
  return fetchImpl;
}

async function download(path, metadataByPath, options = {}) {
  const fetchImpl = createFetch(metadataByPath, options);
  const waitUntilPromises = [];
  const response = await handleDesktopDownloadRequest(
    new Request(`https://tutti.sh${path}`, {
      method: options.method ?? "GET"
    }),
    {
      TUTTI_ANALYTICS_APP_ID: "20004134",
      TUTTI_ANALYTICS_APP_KEY: "test-app-key",
      TUTTI_ANALYTICS_APP_VERSION: "0.0.0",
      TUTTI_ANALYTICS_CHANNEL_DOMAIN: "https://analytics.example.com",
      TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL: baseUrl,
      ...options.env
    },
    {
      fetch: fetchImpl,
      waitUntil: (promise) => waitUntilPromises.push(promise)
    }
  );
  await Promise.allSettled(waitUntilPromises);
  return {
    analyticsRequests: fetchImpl.analyticsRequests,
    fetchRequests: fetchImpl.requests,
    response
  };
}

test("stable download redirects to the macOS universal DMG from root latest metadata", async () => {
  const { analyticsRequests, fetchRequests, response } = await download(
    "/desktop/download?platform=macos&arch=universal&format=dmg&source=readme",
    {
      "/desktop-release-assets/latest.json": createMetadata()
    }
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `${baseUrl}/v1.2.3/Tutti-1.2.3-mac-universal.dmg`
  );
  assert.deepEqual(fetchRequests, [`${baseUrl}/latest.json`]);
  assert.equal(analyticsRequests.length, 1);
  assert.equal(
    analyticsRequests[0].url,
    "https://analytics.example.com/sdk/log"
  );
  assert.equal(analyticsRequests[0].headers["x-mcs-appkey"], "test-app-key");
  assert.equal(analyticsRequests[0].body.app_type, "app");
  assert.equal(analyticsRequests[0].body.user_unique_id, "public-download");
  assert.equal(analyticsRequests[0].body.header.custom.app_version, "0.0.0");
  assert.deepEqual(analyticsRequests[0].body.event_v3, [
    {
      event: "desktop_download.clicked",
      local_time_ms: analyticsRequests[0].body.event_v3[0].local_time_ms,
      params: {
        arch: "universal",
        asset_name: "Tutti-1.2.3-mac-universal.dmg",
        download_url:
          "https://downloads.example.com/desktop-release-assets/v1.2.3/Tutti-1.2.3-mac-universal.dmg",
        format: "dmg",
        platform: "macos",
        release_channel: "stable",
        release_tag: "v1.2.3",
        release_version: "1.2.3",
        source: "readme"
      }
    }
  ]);
});

test("download analytics defaults source to unknown when query omits source", async () => {
  const { analyticsRequests, response } = await download(
    "/desktop/download?platform=macos&arch=universal&format=dmg",
    {
      "/desktop-release-assets/latest.json": createMetadata()
    }
  );

  assert.equal(response.status, 302);
  assert.equal(analyticsRequests[0].body.event_v3[0].params.source, "unknown");
});

test("download analytics defaults empty source to unknown", async () => {
  const { analyticsRequests, response } = await download(
    "/desktop/download?platform=macos&arch=universal&format=dmg&source=",
    {
      "/desktop-release-assets/latest.json": createMetadata()
    }
  );

  assert.equal(response.status, 302);
  assert.equal(analyticsRequests[0].body.event_v3[0].params.source, "unknown");
});

test("download still redirects when analytics reporting fails", async () => {
  const { analyticsRequests, response } = await download(
    "/desktop/download?platform=macos&arch=universal&format=dmg&source=readme",
    {
      "/desktop-release-assets/latest.json": createMetadata()
    },
    { analyticsStatus: 500 }
  );

  assert.equal(response.status, 302);
  assert.equal(analyticsRequests.length, 1);
});

test("HEAD download redirect does not report analytics", async () => {
  const { analyticsRequests, response } = await download(
    "/desktop/download?platform=macos&arch=universal&format=dmg&source=readme",
    {
      "/desktop-release-assets/latest.json": createMetadata()
    },
    { method: "HEAD" }
  );

  assert.equal(response.status, 302);
  assert.equal(analyticsRequests.length, 0);
});

test("latest endpoint rewrites assets to public download URLs", async () => {
  const { response } = await download(
    "/desktop/latest.json?channel=preview",
    {
      "/desktop-release-assets/channels/preview/latest.json": createMetadata({
        tag: "v1.2.4-rc.1",
        version: "1.2.4-rc.1",
        channel: "rc",
        prerelease: true,
        preferredDownloads: {
          macosUniversalDmg: `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
        },
        assets: [
          {
            name: "Tutti-1.2.4-rc.1-mac-universal.dmg",
            platform: "macos",
            arch: "universal",
            format: "dmg",
            url: `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
          }
        ]
      })
    }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.downloadChannel, "preview");
  assert.equal(
    body.assets[0].cdnUrl,
    `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
  );
  assert.equal(
    body.assets[0].url,
    "https://tutti.sh/desktop/download?channel=preview&platform=macos&arch=universal&format=dmg"
  );
});

test("preview channel reads preview latest metadata and requires an rc package", async () => {
  const metadata = createMetadata({
    tag: "v1.2.4-rc.1",
    version: "1.2.4-rc.1",
    channel: "rc",
    prerelease: true,
    preferredDownloads: {
      macosUniversalDmg: `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
    },
    assets: [
      {
        name: "Tutti-1.2.4-rc.1-mac-universal.dmg",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        url: `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
      }
    ]
  });

  const { fetchRequests, response } = await download(
    "/desktop/download?channel=preview&platform=macos&arch=universal&format=dmg",
    {
      "/desktop-release-assets/channels/preview/latest.json": metadata
    }
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
  );
  assert.deepEqual(fetchRequests, [
    `${baseUrl}/channels/preview/latest.json`
  ]);
});

test("rc channel alias reads preview latest metadata", async () => {
  const metadata = createMetadata({
    tag: "v1.2.4-rc.1",
    version: "1.2.4-rc.1",
    channel: "rc",
    prerelease: true,
    preferredDownloads: {
      macosUniversalDmg: `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
    },
    assets: [
      {
        name: "Tutti-1.2.4-rc.1-mac-universal.dmg",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        url: `${baseUrl}/v1.2.4-rc.1/Tutti-1.2.4-rc.1-mac-universal.dmg`
      }
    ]
  });

  const { fetchRequests, response } = await download(
    "/desktop/download?channel=rc&platform=macos&arch=universal&format=dmg",
    {
      "/desktop-release-assets/channels/preview/latest.json": metadata
    }
  );

  assert.equal(response.status, 302);
  assert.deepEqual(fetchRequests, [
    `${baseUrl}/channels/preview/latest.json`
  ]);
});

test("stable channel falls back to GitHub latest when mirrored metadata points at a prerelease", async () => {
  const { analyticsRequests, response } = await download(
    "/desktop/download?platform=macos&arch=universal&format=dmg",
    {
      "/desktop-release-assets/latest.json": createMetadata({
        tag: "v1.2.4-rc.1",
        version: "1.2.4-rc.1",
        channel: "rc",
        prerelease: true
      }),
      "api.github.com/repos/tutti-os/tutti/releases/latest": {
        tag_name: "v1.2.3",
        prerelease: false,
        draft: false,
        published_at: "2026-07-06T00:00:00.000Z",
        created_at: "2026-07-06T00:00:00.000Z",
        target_commitish: "main",
        html_url: "https://github.com/tutti-os/tutti/releases/tag/v1.2.3",
        assets: [
          {
            name: "Tutti-1.2.3-mac-universal.dmg",
            size: 123,
            browser_download_url:
              "https://github.com/tutti-os/tutti/releases/download/v1.2.3/Tutti-1.2.3-mac-universal.dmg"
          }
        ]
      }
    }
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/tutti-os/tutti/releases/download/v1.2.3/Tutti-1.2.3-mac-universal.dmg"
  );
  assert.equal(analyticsRequests.length, 1);
});

test("unsupported asset combinations return not found instead of redirecting", async () => {
  const { analyticsRequests, response } = await download(
    "/desktop/download?platform=windows&arch=arm64&format=exe",
    {
      "/desktop-release-assets/latest.json": createMetadata()
    }
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(
    body.assets[0].url,
    "https://tutti.sh/desktop/download?platform=macos&arch=universal&format=dmg"
  );
  assert.equal(analyticsRequests.length, 0);
});
