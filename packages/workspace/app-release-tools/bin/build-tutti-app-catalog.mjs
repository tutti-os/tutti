#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  releaseToCatalogApp,
  validateRelease
} from "./build-tutti-app-release.mjs";
import { validateVersionsDocument } from "./build-tutti-app-versions.mjs";
import {
  compareReleaseVersions,
  compareSemver
} from "./tutti-app-versioning.mjs";

export const catalogSchemaVersion = "tutti.app.catalog.v1";
export const maxCatalogBytes = 1024 * 1024;

export async function buildTuttiAppCatalog(options) {
  const existingCatalogPath = options.existingCatalogPath
    ? path.resolve(String(options.existingCatalogPath))
    : null;
  const releaseFiles = normalizeFiles(options.releaseFiles);
  const versionsFiles = normalizeFiles(options.versionsFiles);
  const outputPath = path.resolve(
    options.outputPath
      ? String(options.outputPath)
      : "dist/tutti-app-catalog/catalog.json"
  );

  const appsByID = new Map();
  const compatibilityByAppID = new Map();
  if (existingCatalogPath) {
    const existingCatalog = JSON.parse(
      await readFile(existingCatalogPath, "utf8")
    );
    validateCatalog(existingCatalog);
    for (const app of existingCatalog.apps) {
      appsByID.set(app.manifest.appId, app);
    }
    for (const [appId, entries] of Object.entries(
      existingCatalog.compatibility?.apps ?? {}
    )) {
      compatibilityByAppID.set(appId, entries);
    }
  }

  const seenVersionsAppIDs = new Set();
  for (const versionsFile of versionsFiles) {
    const versions = JSON.parse(await readFile(versionsFile, "utf8"));
    validateVersionsDocument(versions);
    if (seenVersionsAppIDs.has(versions.appId)) {
      throw new Error(`duplicate versions appId ${versions.appId}`);
    }
    seenVersionsAppIDs.add(versions.appId);
    applyVersionsDocument(appsByID, compatibilityByAppID, versions);
  }

  const seenReleaseAppIDs = new Set();
  for (const releaseFile of releaseFiles) {
    const release = JSON.parse(await readFile(releaseFile, "utf8"));
    validateRelease(release);
    if (seenReleaseAppIDs.has(release.appId)) {
      throw new Error(`duplicate release appId ${release.appId}`);
    }
    if (seenVersionsAppIDs.has(release.appId)) {
      throw new Error(
        `appId ${release.appId} cannot be supplied as both release and versions metadata`
      );
    }
    seenReleaseAppIDs.add(release.appId);
    appsByID.set(release.appId, releaseToCatalogApp(release));
  }

  if (appsByID.size === 0 && compatibilityByAppID.size === 0) {
    throw new Error(
      "at least one versions file, release file, or existing catalog app is required"
    );
  }

  const apps = [...appsByID.values()].sort((left, right) =>
    left.manifest.appId.localeCompare(right.manifest.appId)
  );
  const compatibilityApps = Object.fromEntries(
    [...compatibilityByAppID.entries()]
      .filter(([, entries]) => entries.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const catalog = {
    schemaVersion: catalogSchemaVersion,
    apps,
    ...(Object.keys(compatibilityApps).length > 0
      ? { compatibility: { apps: compatibilityApps } }
      : {})
  };
  validateCatalog(catalog);

  const encoded = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > maxCatalogBytes) {
    throw new Error(
      `catalog exceeds legacy ${maxCatalogBytes}-byte response limit`
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, encoded);
  return { outputPath, catalog };
}

export function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("catalog must be an object");
  }
  if (catalog.schemaVersion !== catalogSchemaVersion) {
    throw new Error(`catalog schemaVersion must be ${catalogSchemaVersion}`);
  }
  if (!Array.isArray(catalog.apps)) {
    throw new Error("catalog apps must be an array");
  }

  const seenLegacyAppIDs = new Set();
  for (const [index, app] of catalog.apps.entries()) {
    const appId = validateCatalogApp(app, `catalog apps[${index}]`);
    if (seenLegacyAppIDs.has(appId)) {
      throw new Error(`duplicate catalog appId ${appId}`);
    }
    seenLegacyAppIDs.add(appId);
  }

  const compatibility = catalog.compatibility;
  if (compatibility === undefined) {
    return catalog;
  }
  if (
    !compatibility ||
    typeof compatibility !== "object" ||
    Array.isArray(compatibility) ||
    !compatibility.apps ||
    typeof compatibility.apps !== "object" ||
    Array.isArray(compatibility.apps)
  ) {
    throw new Error("catalog compatibility.apps must be an object");
  }
  for (const [appId, entries] of Object.entries(compatibility.apps)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`catalog compatibility app ${appId} must be non-empty`);
    }
    const seenVersions = new Set();
    const seenMinimums = new Set();
    for (const [index, entry] of entries.entries()) {
      const label = `catalog compatibility app ${appId}[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${label} must be an object`);
      }
      const minTuttiVersion = String(entry.minTuttiVersion ?? "").trim();
      compareSemver(minTuttiVersion, minTuttiVersion);
      if (seenMinimums.has(minTuttiVersion)) {
        throw new Error(`${label} has duplicate minTuttiVersion`);
      }
      seenMinimums.add(minTuttiVersion);
      const entryAppId = validateCatalogApp(entry.app, `${label}.app`);
      if (entryAppId !== appId) {
        throw new Error(`${label}.app manifest.appId must match map key`);
      }
      const version = entry.app.manifest.version;
      if (seenVersions.has(version)) {
        throw new Error(`${label} has duplicate app version ${version}`);
      }
      seenVersions.add(version);
    }
  }
  return catalog;
}

export function validateCatalogApp(app, label) {
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw new Error(`${label} must be an object`);
  }
  const appId = String(app.manifest?.appId ?? "").trim();
  const version = String(app.manifest?.version ?? "").trim();
  if (!appId) {
    throw new Error(`${label}.manifest.appId is required`);
  }
  compareSemver(version, version);
  const distribution = app.distribution;
  if (!distribution || distribution.kind !== "remote") {
    throw new Error(`${label}.distribution.kind must be remote`);
  }
  for (const key of ["artifactUrl", "artifactSha256", "iconUrl"]) {
    if (
      typeof distribution[key] !== "string" ||
      distribution[key].trim() === ""
    ) {
      throw new Error(`${label}.distribution.${key} is required`);
    }
  }
  if (!/^[a-f0-9]{64}$/iu.test(distribution.artifactSha256)) {
    throw new Error(`${label}.distribution.artifactSha256 must be sha256`);
  }
  return appId;
}

function applyVersionsDocument(appsByID, compatibilityByAppID, versions) {
  const activeRecords = versions.versions.filter(
    (record) => record.status === "active"
  );
  const legacyRecords = activeRecords.filter(
    (record) => record.minTuttiVersion === "0.0.0"
  );
  const legacy = highestReleaseRecord(legacyRecords);
  if (legacy) {
    appsByID.set(versions.appId, releaseToCatalogApp(legacy.release));
  } else {
    appsByID.delete(versions.appId);
  }

  const entries = compatibilityFrontier(activeRecords).map((record) => ({
    minTuttiVersion: record.minTuttiVersion,
    app: releaseToCatalogApp(record.release)
  }));
  if (entries.length > 0) {
    compatibilityByAppID.set(versions.appId, entries);
  } else {
    compatibilityByAppID.delete(versions.appId);
  }
}

export function compatibilityFrontier(records) {
  const highestByMinimum = new Map();
  for (const record of records) {
    const existing = highestByMinimum.get(record.minTuttiVersion);
    if (
      !existing ||
      compareReleaseVersions(record.release, existing.release) > 0
    ) {
      highestByMinimum.set(record.minTuttiVersion, record);
    }
  }

  const candidates = [...highestByMinimum.values()].sort((left, right) => {
    const minimum = compareSemver(left.minTuttiVersion, right.minTuttiVersion);
    if (minimum !== 0) {
      return minimum;
    }
    return compareReleaseVersions(left.release, right.release);
  });
  const frontier = [];
  let highest = null;
  for (const candidate of candidates) {
    if (
      !highest ||
      compareReleaseVersions(candidate.release, highest.release) > 0
    ) {
      frontier.push(candidate);
      highest = candidate;
    }
  }
  return frontier;
}

function highestReleaseRecord(records) {
  return [...records]
    .sort((left, right) => compareReleaseVersions(left.release, right.release))
    .at(-1);
}

function normalizeFiles(value) {
  const files = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/[\n,]/u)
        .map((file) => file.trim())
        .filter(Boolean);
  return files.map((file) => path.resolve(file));
}

function parseArgs(argv) {
  const result = { releaseFiles: [], versionsFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (
      [
        "--release-file",
        "--versions-file",
        "--existing-catalog",
        "--output"
      ].includes(arg)
    ) {
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      if (arg === "--release-file") {
        result.releaseFiles.push(value);
      } else if (arg === "--versions-file") {
        result.versionsFiles.push(value);
      } else if (arg === "--existing-catalog") {
        result.existingCatalogPath = value;
      } else {
        result.outputPath = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

export async function main() {
  const result = await buildTuttiAppCatalog(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.catalog, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
