#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const mobileReleaseLatestSchemaVersion =
  "tutti.android.mobile.latest.v1";
export const mobilePackageName = "sh.tutti.mobile";

export async function buildMobileReleaseLatest(options) {
  const apkPath = path.resolve(requireNonEmpty(options.apkPath, "apkPath"));
  const baseUrl = normalizeBaseURL(requireNonEmpty(options.baseURL, "baseURL"));
  const tag = requireNonEmpty(options.tag, "tag");
  const versionName = requireNonEmpty(options.versionName, "versionName");
  const versionCode = parsePositiveInteger(options.versionCode, "versionCode");
  const releasedAt = requireNonEmpty(options.releasedAt, "releasedAt");
  if (!Number.isFinite(Date.parse(releasedAt))) {
    throw new Error("releasedAt must be an ISO date");
  }

  const apkStat = await stat(apkPath);
  const sha256 = createHash("sha256")
    .update(await readFile(apkPath))
    .digest("hex");
  const apkName = path.basename(apkPath);

  return {
    apkUrl: `${baseUrl}/${encodeURLPathSegment(tag)}/${encodeURLPathSegment(apkName)}`,
    baseUrl,
    mandatory: false,
    packageName: mobilePackageName,
    releasedAt,
    schemaVersion: mobileReleaseLatestSchemaVersion,
    sha256,
    sizeBytes: apkStat.size,
    tag,
    versionCode,
    versionName
  };
}

function normalizeBaseURL(value) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:") {
    throw new Error("baseURL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("baseURL must not include credentials, query, or hash");
  }
  return parsed.href.replace(/\/+$/, "");
}

function requireNonEmpty(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function encodeURLPathSegment(value) {
  return encodeURIComponent(value);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    result[key.replaceAll("-", "")] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const latest = await buildMobileReleaseLatest({
    apkPath: args.apk,
    baseURL: args.baseurl,
    releasedAt: args.releasedat ?? new Date().toISOString(),
    tag: args.tag,
    versionCode: args.versioncode,
    versionName: args.versionname
  });
  await writeFile(
    path.resolve(requireNonEmpty(args.output, "output")),
    `${JSON.stringify(latest, null, 2)}\n`,
    "utf8"
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
