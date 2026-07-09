const DEFAULT_ASSET_BASE_URL =
  "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-desktop-release-assets";
const PUBLIC_DOWNLOAD_URL = "https://tutti.sh/desktop/download";
const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/tutti-os/tutti/releases/latest";
const releaseLatestSchemaVersion = "tutti.desktop.release.latest.v1";
const analyticsEventName = "desktop_download.clicked";
const publicDownloadUserId = "public-download";

const CHANNEL_LATEST_PATHS = {
  stable: "latest.json",
  preview: "channels/preview/latest.json",
  beta: "channels/beta/latest.json"
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createAnalyticsEvent(name, params) {
  return {
    clientTs: Date.now(),
    name,
    params
  };
}

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function normalizeSource(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "unknown";
}

function normalizeChannel(value) {
  if (!value) {
    return "stable";
  }
  const channel = value.trim().toLowerCase();
  if (channel === "stable") {
    return "stable";
  }
  if (channel === "preview" || channel === "rc") {
    return "preview";
  }
  if (channel === "beta") {
    return "beta";
  }
  throw new HttpError(`unsupported channel: ${value}`, 400);
}

function resolveAssetBaseUrl(env = {}) {
  return (
    normalizeBaseUrl(env.TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL) ||
    DEFAULT_ASSET_BASE_URL
  );
}

function resolveAnalyticsConfig(env) {
  const appId = Number.parseInt(String(env.TUTTI_ANALYTICS_APP_ID ?? ""), 10);
  const appKey = String(env.TUTTI_ANALYTICS_APP_KEY ?? "").trim();
  const channelDomain = normalizeBaseUrl(
    env.TUTTI_ANALYTICS_CHANNEL_DOMAIN ?? ""
  );
  if (
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    !appKey ||
    !isSupportedHttpsUrl(channelDomain)
  ) {
    return null;
  }
  return {
    appId,
    appKey,
    appVersion:
      String(env.TUTTI_ANALYTICS_APP_VERSION ?? "0.0.0").trim() || "0.0.0",
    channelDomain
  };
}

function isSupportedHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleDesktopDownloadRequest(
  request,
  env = {},
  options = {}
) {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const url = new URL(request.url);
    const channel = normalizeChannel(url.searchParams.get("channel"));
    const assetBaseUrl = resolveAssetBaseUrl(env);

    if (url.pathname === "/desktop/latest.json") {
      const latest = await resolveLatest(channel, {
        assetBaseUrl,
        fetchImpl
      });
      return Response.json(rewriteLatest(latest, channel), {
        headers: {
          "cache-control": "public, max-age=60"
        }
      });
    }

    if (url.pathname === "/desktop/download") {
      const latest = await resolveLatest(channel, {
        assetBaseUrl,
        fetchImpl
      });
      const asset = findAsset(latest.assets, url.searchParams);
      if (!asset) {
        return Response.json(
          {
            error: "asset_not_found",
            assets: rewriteAssets(latest.assets, channel)
          },
          {
            status: 404,
            headers: {
              "cache-control": "no-store"
            }
          }
        );
      }

      const redirectUrl = asset.cdnUrl || asset.url;
      if (request.method === "GET") {
        trackDownloadClicked({
          analytics: resolveAnalyticsConfig(env),
          asset,
          fetchImpl,
          latest,
          releaseChannel: channel,
          redirectUrl,
          source: normalizeSource(url.searchParams.get("source")),
          waitUntil: options.waitUntil
        });
      }

      return Response.redirect(redirectUrl, 302);
    }

    return Response.json(
      {
        error: "not_found"
      },
      {
        status: 404,
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    return Response.json(
      {
        error:
          status === 400 ? "bad_request" : "desktop_download_unavailable",
        message: error instanceof Error ? error.message : String(error)
      },
      {
        status,
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  }
}

async function resolveLatest(channel, { assetBaseUrl, fetchImpl }) {
  const latest = await fetchChannelLatest(channel, { assetBaseUrl, fetchImpl });
  if (channel === "stable") {
    try {
      validateLatest(latest, "stable");
      return latest;
    } catch {
      return fetchGitHubStableLatest(fetchImpl);
    }
  }
  validateLatest(latest, channel);
  return latest;
}

async function fetchChannelLatest(channel, { assetBaseUrl, fetchImpl }) {
  const latestUrl = new URL(CHANNEL_LATEST_PATHS[channel], `${assetBaseUrl}/`);
  const response = await fetchImpl(latestUrl.href, {
    cf: {
      cacheEverything: true,
      cacheTtl: 60
    }
  });
  if (!response.ok) {
    throw new Error(
      `failed to fetch ${latestUrl.pathname}: ${response.status}`
    );
  }
  return response.json();
}

async function fetchGitHubStableLatest(fetchImpl) {
  const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "tutti-desktop-download-worker"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60
    }
  });
  if (!response.ok) {
    throw new Error(`failed to fetch GitHub latest release: ${response.status}`);
  }
  const release = await response.json();
  if (
    release.prerelease === true ||
    release.draft === true ||
    !/^v\d+\.\d+\.\d+$/.test(String(release.tag_name || ""))
  ) {
    throw new Error("GitHub latest release is not a stable desktop release");
  }
  const assets = Array.isArray(release.assets)
    ? release.assets.map(githubAssetToLatestAsset)
    : [];
  return {
    schemaVersion: releaseLatestSchemaVersion,
    tag: release.tag_name,
    version: String(release.tag_name).replace(/^v/, ""),
    channel: "stable",
    prerelease: false,
    releasedAt:
      release.published_at || release.created_at || new Date().toISOString(),
    gitSha: release.target_commitish || null,
    sourceRef: release.target_commitish || null,
    baseUrl: release.html_url,
    preferredDownloads: {
      macosUniversalDmg:
        assets.find(
          (asset) =>
            asset.platform === "macos" &&
            asset.arch === "universal" &&
            asset.format === "dmg"
        )?.url || null
    },
    assets
  };
}

function githubAssetToLatestAsset(asset) {
  const metadata = parseAssetName(String(asset.name || ""));
  return {
    ...metadata,
    name: asset.name,
    sizeBytes: asset.size || 0,
    url: asset.browser_download_url
  };
}

function parseAssetName(name) {
  let format = name.split(".").pop() || "unknown";
  if (name.endsWith(".zip.blockmap")) {
    format = "blockmap";
  }
  const metadata = {
    arch: "unknown",
    format,
    platform: "unknown"
  };
  const macMatch = name.match(/-mac-(x64|arm64|universal)\.(dmg|zip)$/);
  if (macMatch) {
    metadata.platform = "macos";
    metadata.arch = macMatch[1];
    metadata.format = macMatch[2];
  }
  return metadata;
}

function validateLatest(latest, channel) {
  if (!latest || typeof latest !== "object") {
    throw new Error("latest metadata is not an object");
  }
  if (!Array.isArray(latest.assets)) {
    throw new Error("latest metadata is missing assets");
  }
  const version = String(latest.version || "");
  const tag = String(latest.tag || "");
  if (channel === "stable") {
    if (
      (latest.channel != null && latest.channel !== "stable") ||
      latest.prerelease === true ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      !/^v\d+\.\d+\.\d+$/.test(tag)
    ) {
      throw new Error("stable latest metadata must point to a stable release");
    }
    return;
  }
  if (channel === "preview") {
    if (
      latest.channel !== "rc" ||
      latest.prerelease !== true ||
      !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version) ||
      !/^v\d+\.\d+\.\d+-rc\.\d+$/.test(tag)
    ) {
      throw new Error("preview latest metadata must point to an RC release");
    }
    return;
  }
  if (
    latest.channel !== "beta" ||
    latest.prerelease !== true ||
    !/^\d+\.\d+\.\d+-beta\.\d+$/.test(version) ||
    !/^v\d+\.\d+\.\d+-beta\.\d+$/.test(tag)
  ) {
    throw new Error("beta latest metadata must point to a beta release");
  }
}

function rewriteLatest(latest, channel) {
  return {
    ...latest,
    downloadChannel: channel,
    assets: rewriteAssets(latest.assets, channel)
  };
}

function rewriteAssets(assets, channel) {
  return assets.map((asset) => ({
    ...asset,
    cdnUrl: asset.cdnUrl || asset.url,
    url: publicDownloadUrl(asset, channel)
  }));
}

function publicDownloadUrl(asset, channel) {
  const url = new URL(PUBLIC_DOWNLOAD_URL);
  if (channel !== "stable") {
    url.searchParams.set("channel", channel);
  }
  url.searchParams.set("platform", asset.platform);
  url.searchParams.set("arch", asset.arch);
  url.searchParams.set("format", asset.format);
  return url.href;
}

function findAsset(assets, params) {
  const platform = params.get("platform");
  const arch = params.get("arch");
  const format = params.get("format");
  return assets.find(
    (asset) =>
      asset.platform === platform &&
      asset.arch === arch &&
      asset.format === format
  );
}

function createDesktopDownloadClickedEvent({
  asset,
  latest,
  releaseChannel,
  redirectUrl,
  source
}) {
  return createAnalyticsEvent(analyticsEventName, {
    arch: asset.arch,
    asset_name: asset.name ?? "",
    download_url: redirectUrl,
    format: asset.format,
    platform: asset.platform,
    release_channel: releaseChannel,
    release_tag: latest.tag,
    release_version: latest.version,
    source
  });
}

function buildTeaEventPayload({ analytics, event }) {
  return {
    app_type: "app",
    user_unique_id: publicDownloadUserId,
    header: {
      custom: {
        app_version: analytics.appVersion,
        os: "cloudflare_worker",
        surface: "desktop_download_worker"
      },
      user_unique_id: publicDownloadUserId
    },
    event_v3: [
      {
        event: event.name,
        local_time_ms: event.clientTs,
        params: event.params
      }
    ]
  };
}

async function sendTeaDownloadEvent(fetchImpl, analytics, payload) {
  const response = await fetchImpl(`${analytics.channelDomain}/sdk/log`, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      "x-mcs-appkey": analytics.appKey
    },
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`analytics request failed with ${response.status}`);
  }
}

function trackDownloadClicked({
  analytics,
  asset,
  fetchImpl,
  latest,
  releaseChannel,
  redirectUrl,
  source,
  waitUntil
}) {
  if (!analytics) {
    return;
  }
  const event = createDesktopDownloadClickedEvent({
    asset,
    latest,
    releaseChannel,
    redirectUrl,
    source
  });
  const payload = buildTeaEventPayload({ analytics, event });
  const promise = sendTeaDownloadEvent(fetchImpl, analytics, payload).catch(
    () => undefined
  );
  if (typeof waitUntil === "function") {
    waitUntil(promise);
    return;
  }
  void promise;
}

export default {
  fetch(request, env, ctx) {
    return handleDesktopDownloadRequest(request, env, {
      waitUntil: ctx?.waitUntil?.bind(ctx)
    });
  }
};

export {
  HttpError,
  buildTeaEventPayload,
  createAnalyticsEvent,
  createDesktopDownloadClickedEvent,
  fetchGitHubStableLatest,
  findAsset,
  handleDesktopDownloadRequest,
  normalizeBaseUrl,
  normalizeChannel,
  normalizeSource,
  parseAssetName,
  publicDownloadUrl,
  resolveAnalyticsConfig,
  resolveLatest,
  rewriteAssets,
  rewriteLatest,
  validateLatest
};
