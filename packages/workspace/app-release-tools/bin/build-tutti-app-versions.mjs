#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { validateRelease } from "./build-tutti-app-release.mjs";
import {
  compareReleaseVersions,
  requireSemver
} from "./tutti-app-versioning.mjs";

export const versionsSchemaVersion = "tutti.app.versions.v1";

export async function buildTuttiAppVersions(options) {
  const existingPath = options.existingVersionsPath
    ? path.resolve(String(options.existingVersionsPath))
    : null;
  const releaseFiles = normalizeFiles(options.releaseFiles);
  const baselineReleaseFiles = normalizeFiles(options.baselineReleaseFiles);
  const outputPath = path.resolve(
    options.outputPath
      ? String(options.outputPath)
      : "dist/tutti-app-release/versions.json"
  );

  let document = null;
  if (existingPath) {
    document = JSON.parse(await readFile(existingPath, "utf8"));
    validateVersionsDocument(document);
  }

  for (const releaseFile of baselineReleaseFiles) {
    const release = JSON.parse(await readFile(releaseFile, "utf8"));
    validateRelease(release);
    document = addVersionRecord(document, {
      minTuttiVersion: "0.0.0",
      status: "active",
      release
    });
  }

  if (releaseFiles.length > 0) {
    const minTuttiVersion = requireSemver(
      options.minTuttiVersion,
      "minTuttiVersion"
    );
    const status = normalizeStatus(options.status ?? "active");
    for (const releaseFile of releaseFiles) {
      const release = JSON.parse(await readFile(releaseFile, "utf8"));
      validateRelease(release);
      document = addVersionRecord(document, {
        minTuttiVersion,
        status,
        release
      });
    }
  }

  if (options.setStatusVersion) {
    if (!document) {
      throw new Error("existing versions are required when setting status");
    }
    const version = requireSemver(options.setStatusVersion, "setStatusVersion");
    const status = normalizeStatus(options.status);
    const record = document.versions.find(
      (candidate) => candidate.release.version === version
    );
    if (!record) {
      throw new Error(`version ${version} is not present in versions index`);
    }
    record.status = status;
  }

  if (!document || document.versions.length === 0) {
    throw new Error(
      "at least one release, baseline release, or existing versions document is required"
    );
  }

  document.versions.sort((left, right) =>
    compareReleaseVersions(left.release, right.release)
  );
  validateVersionsDocument(document);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  return { outputPath, versions: document };
}

export function validateVersionsDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("versions document must be an object");
  }
  if (document.schemaVersion !== versionsSchemaVersion) {
    throw new Error(`versions schemaVersion must be ${versionsSchemaVersion}`);
  }
  const appId = requireNonEmpty(document.appId, "versions appId");
  if (!Array.isArray(document.versions)) {
    throw new Error("versions must be an array");
  }
  const seenVersions = new Set();
  for (const [index, record] of document.versions.entries()) {
    const label = `versions[${index}]`;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`${label} must be an object`);
    }
    record.minTuttiVersion = requireSemver(
      record.minTuttiVersion,
      `${label}.minTuttiVersion`
    );
    record.status = normalizeStatus(record.status);
    validateRelease(record.release);
    if (record.release.appId !== appId) {
      throw new Error(`${label}.release.appId must match versions appId`);
    }
    const version = requireSemver(
      record.release.version,
      `${label}.release.version`
    );
    if (seenVersions.has(version)) {
      throw new Error(`duplicate versions release version ${version}`);
    }
    seenVersions.add(version);
  }
  return document;
}

function addVersionRecord(document, record) {
  const appId = record.release.appId;
  const result = document ?? {
    schemaVersion: versionsSchemaVersion,
    appId,
    versions: []
  };
  validateVersionsDocument(result);
  if (result.appId !== appId) {
    throw new Error(
      `release appId ${appId} must match versions appId ${result.appId}`
    );
  }

  const existing = result.versions.find(
    (candidate) => candidate.release.version === record.release.version
  );
  if (!existing) {
    result.versions.push(record);
    return result;
  }
  if (JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(
      `version ${record.release.version} already exists with different compatibility or release metadata`
    );
  }
  return result;
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

function normalizeStatus(value) {
  const status = String(value ?? "").trim();
  if (status !== "active" && status !== "withdrawn") {
    throw new Error("status must be active or withdrawn");
  }
  return status;
}

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function parseArgs(argv) {
  const result = { releaseFiles: [], baselineReleaseFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (
      [
        "--existing-versions",
        "--release-file",
        "--baseline-release-file",
        "--min-tutti-version",
        "--set-status-version",
        "--status",
        "--output"
      ].includes(arg)
    ) {
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      const key = {
        "--existing-versions": "existingVersionsPath",
        "--min-tutti-version": "minTuttiVersion",
        "--set-status-version": "setStatusVersion",
        "--status": "status",
        "--output": "outputPath"
      }[arg];
      if (arg === "--release-file") {
        result.releaseFiles.push(value);
      } else if (arg === "--baseline-release-file") {
        result.baselineReleaseFiles.push(value);
      } else {
        result[key] = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

export async function main() {
  const result = await buildTuttiAppVersions(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.versions, null, 2)}\n`);
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
