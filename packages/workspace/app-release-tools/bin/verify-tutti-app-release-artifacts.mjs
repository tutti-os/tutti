#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  validateCatalog,
  validateCatalogApp
} from "./build-tutti-app-catalog.mjs";
import { validateRelease } from "./build-tutti-app-release.mjs";
import { validateVersionsDocument } from "./build-tutti-app-versions.mjs";

export async function verifyTuttiAppReleaseArtifacts(options) {
  const releaseFiles = normalizeFiles(options.releaseFiles);
  const versionsFiles = normalizeFiles(options.versionsFiles);
  const catalogFile = options.catalogFile
    ? path.resolve(String(options.catalogFile))
    : null;
  const verifyArtifacts = options.verifyArtifacts !== false;

  if (releaseFiles.length === 0 && versionsFiles.length === 0 && !catalogFile) {
    throw new Error(
      "at least one --release-file, --versions-file, or --catalog-file is required"
    );
  }

  const releasesByKey = new Map();
  for (const versionsFile of versionsFiles) {
    const document = JSON.parse(await readFile(versionsFile, "utf8"));
    validateVersionsDocument(document);
    for (const record of document.versions) {
      const key = releaseKey(record.release.appId, record.release.version);
      if (releasesByKey.has(key)) {
        throw new Error(`duplicate versions release ${key}`);
      }
      releasesByKey.set(key, record.release);
    }
  }

  const checks = new Map();
  for (const releaseFile of releaseFiles) {
    const release = JSON.parse(await readFile(releaseFile, "utf8"));
    validateRelease(release);
    const key = releaseKey(release.appId, release.version);
    const existing = releasesByKey.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(release)) {
      throw new Error(`release ${key} does not match versions metadata`);
    }
    releasesByKey.set(key, release);
    addArtifactCheck(checks, release, `release ${key}`);
  }

  if (catalogFile) {
    const catalog = JSON.parse(await readFile(catalogFile, "utf8"));
    validateCatalog(catalog);
    for (const app of catalog.apps) {
      addCatalogAppCheck(checks, releasesByKey, app, "catalog legacy app");
    }
    for (const [appId, entries] of Object.entries(
      catalog.compatibility?.apps ?? {}
    )) {
      for (const entry of entries) {
        addCatalogAppCheck(
          checks,
          releasesByKey,
          entry.app,
          `catalog compatibility app ${appId}`
        );
      }
    }
  }

  if (verifyArtifacts) {
    for (const check of checks.values()) {
      const digest = await digestArtifact(check.artifactUrl);
      if (digest.sha256 !== check.artifactSha256.toLowerCase()) {
        throw new Error(
          `${check.source} artifact sha256 mismatch: want ${check.artifactSha256} got ${digest.sha256}`
        );
      }
      if (
        Number.isSafeInteger(check.artifactSizeBytes) &&
        digest.size !== check.artifactSizeBytes
      ) {
        throw new Error(
          `${check.source} artifact size mismatch: want ${check.artifactSizeBytes} got ${digest.size}`
        );
      }
    }
  }

  return {
    catalogFile,
    releaseFiles,
    versionsFiles,
    checkedArtifactCount: verifyArtifacts ? checks.size : 0
  };
}

function addCatalogAppCheck(checks, releasesByKey, app, source) {
  const appId = validateCatalogApp(app, source);
  const version = app.manifest.version;
  const release = releasesByKey.get(releaseKey(appId, version));
  if (release) assertCatalogMatchesRelease(app, release);
  addArtifactCheck(
    checks,
    {
      appId,
      version,
      artifactUrl: app.distribution.artifactUrl,
      artifactSha256: app.distribution.artifactSha256,
      artifactSizeBytes: release?.artifactSizeBytes
    },
    `${source} ${appId}@${version}`
  );
}

function addArtifactCheck(checks, release, source) {
  const existing = checks.get(release.artifactUrl);
  const check = {
    artifactUrl: release.artifactUrl,
    artifactSha256: release.artifactSha256,
    artifactSizeBytes: release.artifactSizeBytes,
    source
  };
  if (
    existing &&
    (existing.artifactSha256 !== check.artifactSha256 ||
      (Number.isSafeInteger(existing.artifactSizeBytes) &&
        Number.isSafeInteger(check.artifactSizeBytes) &&
        existing.artifactSizeBytes !== check.artifactSizeBytes))
  ) {
    throw new Error(`artifact metadata conflicts for ${release.artifactUrl}`);
  }
  checks.set(release.artifactUrl, existing ?? check);
}

function assertCatalogMatchesRelease(app, release) {
  const appId = release.appId;
  const distribution = app.distribution;
  if (app.manifest.version !== release.version) {
    throw new Error(
      `catalog app ${appId} manifest.version must match release version`
    );
  }
  if (distribution.artifactUrl !== release.artifactUrl) {
    throw new Error(
      `catalog app ${appId} artifactUrl must match latest release metadata`
    );
  }
  if (distribution.artifactSha256 !== release.artifactSha256) {
    throw new Error(
      `catalog app ${appId} artifactSha256 must match latest release metadata`
    );
  }
  if (distribution.iconUrl !== release.iconUrl) {
    throw new Error(
      `catalog app ${appId} iconUrl must match latest release metadata`
    );
  }
  if (
    JSON.stringify(app.localizations ?? []) !==
    JSON.stringify(release.localizations ?? [])
  ) {
    throw new Error(
      `catalog app ${appId} localizations must match latest release metadata`
    );
  }
}

async function digestArtifact(artifactUrl) {
  const url = String(artifactUrl).trim();
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return digestHTTPArtifact(url);
  }
  if (url.startsWith("file://")) {
    return digestFileArtifact(fileURLToPath(url));
  }
  return digestFileArtifact(path.resolve(url));
}

async function digestHTTPArtifact(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await digestHTTPArtifactOnce(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(1000 * attempt);
    }
  }
  throw lastError;
}

async function digestHTTPArtifactOnce(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `download artifact failed: ${url}: HTTP ${response.status}`
    );
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    size += buffer.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function digestFileArtifact(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size };
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

function releaseKey(appId, version) {
  return `${appId}@${version}`;
}

function parseArgs(argv) {
  const result = {
    releaseFiles: [],
    versionsFiles: [],
    verifyArtifacts: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-artifact-download") {
      result.verifyArtifacts = false;
      continue;
    }
    const value = argv[index + 1];
    if (["--release-file", "--versions-file", "--catalog-file"].includes(arg)) {
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      if (arg === "--release-file") result.releaseFiles.push(value);
      if (arg === "--versions-file") result.versionsFiles.push(value);
      if (arg === "--catalog-file") result.catalogFile = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

export async function main() {
  const result = await verifyTuttiAppReleaseArtifacts(
    parseArgs(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
