import type { AppUpdateChannel } from "../../shared/contracts/ipc.ts";

import { outboundFetch } from "../net/outboundFetch.ts";

const desktopReleaseFeedSchemaVersion = "tutti.desktop.release.latest.v1";

export const desktopReleaseFeedBaseUrl =
  "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-desktop-release-assets";

export interface DesktopReleaseFeed {
  feedUrl: string;
  releasedAt: string;
  tag: string;
  updaterChannel: "latest" | "rc";
  version: string;
}

export type DesktopReleaseFeedResolver = (input: {
  channel: AppUpdateChannel;
}) => Promise<DesktopReleaseFeed>;

interface DesktopReleaseFeedResolverOptions {
  baseUrl?: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

interface DesktopReleaseLatestDocument {
  baseUrl: string;
  channel: string;
  prerelease: boolean;
  releasedAt: string;
  schemaVersion: string;
  tag: string;
  version: string;
}

export function createDesktopReleaseFeedResolver(
  options: DesktopReleaseFeedResolverOptions = {}
): DesktopReleaseFeedResolver {
  const baseUrl = normalizeDesktopReleaseFeedBaseUrl(
    options.baseUrl ?? desktopReleaseFeedBaseUrl
  );
  const fetchImpl = options.fetch ?? outboundFetch;

  return async ({ channel }) => {
    const pointerUrl = resolveDesktopReleasePointerUrl({ baseUrl, channel });
    const response = await fetchImpl(pointerUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Tutti Desktop Updater"
      }
    });
    if (!response.ok) {
      throw new Error(
        `Desktop update pointer request failed: ${response.status}`
      );
    }

    const document = parseDesktopReleaseLatestDocument(await response.text());
    validateDesktopReleaseLatestDocument({ baseUrl, channel, document });

    return {
      feedUrl: `${baseUrl}/${encodeURIComponent(document.tag)}`,
      releasedAt: document.releasedAt,
      tag: document.tag,
      updaterChannel: channel === "rc" ? "rc" : "latest",
      version: document.version
    };
  };
}

export function normalizeDesktopReleaseFeedBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:") {
    throw new Error("Desktop update feed base URL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Desktop update feed base URL must not include credentials, query, or hash"
    );
  }

  return parsed.href.replace(/\/+$/, "");
}

export function resolveDesktopReleasePointerUrl(input: {
  baseUrl: string;
  channel: AppUpdateChannel;
}): string {
  const path =
    input.channel === "rc" ? "channels/rc/latest.json" : "latest.json";
  return new URL(path, `${input.baseUrl}/`).href;
}

function parseDesktopReleaseLatestDocument(
  value: string
): DesktopReleaseLatestDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Desktop update pointer is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Desktop update pointer must be a JSON object");
  }

  return {
    baseUrl: readRequiredString(parsed, "baseUrl"),
    channel: readRequiredString(parsed, "channel"),
    prerelease: readBoolean(parsed, "prerelease"),
    releasedAt: readRequiredString(parsed, "releasedAt"),
    schemaVersion: readRequiredString(parsed, "schemaVersion"),
    tag: readRequiredString(parsed, "tag"),
    version: readRequiredString(parsed, "version")
  };
}

function validateDesktopReleaseLatestDocument(input: {
  baseUrl: string;
  channel: AppUpdateChannel;
  document: DesktopReleaseLatestDocument;
}): void {
  const { baseUrl, channel, document } = input;
  if (document.schemaVersion !== desktopReleaseFeedSchemaVersion) {
    throw new Error(
      `Unsupported desktop update pointer schema: ${document.schemaVersion}`
    );
  }
  if (document.channel !== channel) {
    throw new Error(
      `Desktop update pointer channel mismatch: expected ${channel}, received ${document.channel}`
    );
  }
  if (document.prerelease !== (channel === "rc")) {
    throw new Error(
      "Desktop update pointer prerelease value does not match its channel"
    );
  }
  if (normalizeDesktopReleaseFeedBaseUrl(document.baseUrl) !== baseUrl) {
    throw new Error(
      "Desktop update pointer base URL does not match the packaged feed"
    );
  }
  if (!isIsoDate(document.releasedAt)) {
    throw new Error("Desktop update pointer releasedAt must be an ISO date");
  }

  const tagVersion = releaseVersionFromTag(document.tag);
  if (!tagVersion || tagVersion !== document.version) {
    throw new Error("Desktop update pointer tag and version do not match");
  }
  if (!isVersionInChannel(document.version, channel)) {
    throw new Error(
      `Desktop update pointer version does not belong to ${channel}: ${document.version}`
    );
  }
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersionInChannel(value: string, channel: AppUpdateChannel): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc)\.(0|[1-9]\d*))?$/.exec(
      value
    );
  if (!match) {
    return false;
  }

  return channel === "rc" ? match[4] === "rc" : match[4] === undefined;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`Desktop update pointer ${key} must be a non-empty string`);
  }
  return candidate.trim();
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    throw new Error(`Desktop update pointer ${key} must be a boolean`);
  }
  return candidate;
}

function releaseVersionFromTag(tag: string): string | null {
  const version = tag.replace(/^tutti-desktop-v/, "").replace(/^v/, "");
  return version === tag && !tag.startsWith("v") ? null : version;
}
