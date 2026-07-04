import type { AppUpdateChannel } from "../../shared/contracts/ipc.ts";

import { outboundFetch } from "../net/outboundFetch.ts";

export interface PrefixedDesktopRelease {
  htmlUrl: string | null;
  name: string | null;
  publishedAt: string | null;
  tagName: string;
  version: string;
}

export type PrefixedDesktopReleaseResolver = (input: {
  channel: AppUpdateChannel;
  currentVersion: string;
}) => Promise<PrefixedDesktopRelease | null>;

export interface ParsedDesktopVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

const desktopReleaseTagPrefix = "tutti-desktop-v";
const desktopGithubReleasesAtomUrl =
  "https://github.com/tutti-os/tutti/releases.atom";

interface PrefixedDesktopReleaseResolverOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export function stripDesktopReleaseTagPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(desktopReleaseTagPrefix)
    ? trimmed.slice(desktopReleaseTagPrefix.length)
    : trimmed;
}

export function parseDesktopVersion(
  value: string
): ParsedDesktopVersion | null {
  const normalized = stripDesktopReleaseTagPrefix(value).replace(/^v/, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map((segment) => {
          return /^\d+$/.test(segment) ? Number(segment) : segment;
        })
      : []
  };
}

export function compareDesktopVersions(
  left: ParsedDesktopVersion,
  right: ParsedDesktopVersion
): number {
  const coreDelta =
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch;
  if (coreDelta !== 0) {
    return coreDelta;
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) {
    return 1;
  }
  if (left.prerelease.length > 0 && right.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const delta = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

export function createGitHubPrefixedDesktopReleaseResolver(
  options: PrefixedDesktopReleaseResolverOptions = {}
): PrefixedDesktopReleaseResolver {
  return async ({ channel, currentVersion }) => {
    const current = parseDesktopVersion(currentVersion);
    const fetchImpl = options.fetch ?? outboundFetch;
    const response = await fetchImpl(desktopGithubReleasesAtomUrl, {
      headers: {
        Accept: "application/atom+xml, application/xml, text/xml",
        "User-Agent": "Tutti Desktop Updater"
      }
    });
    if (!response.ok) {
      throw new Error(
        `GitHub releases feed request failed: ${response.status}`
      );
    }

    const releases = parseGitHubReleasesAtom(await response.text());
    let selected: {
      parsedVersion: ParsedDesktopVersion;
      release: PrefixedDesktopRelease;
    } | null = null;

    for (const release of releases) {
      if (!release.tagName.startsWith(desktopReleaseTagPrefix)) {
        continue;
      }

      const parsedVersion = parseDesktopVersion(release.tagName);
      if (!parsedVersion || !isReleaseInChannel(parsedVersion, channel)) {
        continue;
      }
      if (current && compareDesktopVersions(parsedVersion, current) <= 0) {
        continue;
      }
      if (
        selected &&
        compareDesktopVersions(parsedVersion, selected.parsedVersion) <= 0
      ) {
        continue;
      }

      selected = {
        parsedVersion,
        release
      };
    }

    return selected?.release ?? null;
  };
}

function parseGitHubReleasesAtom(feedXml: string): PrefixedDesktopRelease[] {
  const releases: PrefixedDesktopRelease[] = [];
  for (const entry of feedXml.matchAll(/<entry\b[\s\S]*?<\/entry>/g)) {
    const entryXml = entry[0];
    const htmlUrl = readXmlAttribute(entryXml, "link", "href");
    const tagName = htmlUrl ? readReleaseTagFromUrl(htmlUrl) : null;
    if (!tagName) {
      continue;
    }

    releases.push({
      htmlUrl,
      name: readXmlElementText(entryXml, "title"),
      publishedAt: readXmlElementText(entryXml, "updated"),
      tagName,
      version: stripDesktopReleaseTagPrefix(tagName)
    });
  }

  return releases;
}

function comparePrereleaseIdentifier(
  left: number | string,
  right: number | string
): number {
  if (left === right) {
    return 0;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "number") {
    return -1;
  }
  if (typeof right === "number") {
    return 1;
  }
  return left.localeCompare(right);
}

function isReleaseInChannel(
  version: ParsedDesktopVersion,
  channel: AppUpdateChannel
): boolean {
  if (channel === "stable") {
    return version.prerelease.length === 0;
  }

  return version.prerelease[0] === channel;
}

function readReleaseTagFromUrl(value: string): string | null {
  const match = value.match(/\/releases\/tag\/([^/?#]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function readXmlAttribute(
  xml: string,
  elementName: string,
  attributeName: string
): string | null {
  const elementMatch = xml.match(
    new RegExp(`<${elementName}\\b[^>]*\\b${attributeName}="([^"]+)"[^>]*>`)
  );
  return elementMatch?.[1] ? decodeXmlText(elementMatch[1]) : null;
}

function readXmlElementText(xml: string, elementName: string): string | null {
  const match = xml.match(
    new RegExp(`<${elementName}\\b[^>]*>([\\s\\S]*?)<\\/${elementName}>`)
  );
  const text = match?.[1] ? decodeXmlText(match[1]).trim() : "";
  return text.length > 0 ? text : null;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
