#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { buildTuttiAppCatalog } from "./build-tutti-app-catalog.mjs";
import {
  releaseToCatalogApp,
  validateRelease
} from "./build-tutti-app-release.mjs";
import { buildTuttiAppVersions } from "./build-tutti-app-versions.mjs";
import { mergeTuttiAppLatest } from "./merge-tutti-app-latest.mjs";
import { requireSemver } from "./tutti-app-versioning.mjs";

const maxCASAttempts = 3;

export async function publishTuttiAppMetadata(options) {
  const appId = requireNonEmpty(options.appId, "appId");
  const bucket = requireNonEmpty(options.s3Bucket, "s3Bucket");
  const prefix = String(options.s3Prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/gu, "");
  const outputDir = path.resolve(
    String(options.outputDir ?? "tutti-app-metadata")
  );
  const publishCatalog = options.publishCatalog === true;
  const catalogOnly = options.catalogOnly === true;
  const releasePath = options.releasePath
    ? path.resolve(String(options.releasePath))
    : null;
  const minTuttiVersion = options.minTuttiVersion
    ? requireSemver(options.minTuttiVersion, "minTuttiVersion")
    : null;

  if (!catalogOnly && !releasePath) {
    throw new Error("releasePath is required unless catalogOnly is true");
  }
  if (!catalogOnly && !minTuttiVersion) {
    throw new Error("minTuttiVersion is required for app releases");
  }

  await mkdir(outputDir, { recursive: true });
  const release = releasePath
    ? JSON.parse(await readFile(releasePath, "utf8"))
    : null;
  if (release) {
    validateRelease(release);
    if (release.appId !== appId) {
      throw new Error("release appId must match input appId");
    }
  }

  const key = (suffix) => (prefix ? `${prefix}/${suffix}` : suffix);
  const versionsKey = key(`apps/${appId}/versions.json`);
  const latestKey = key(`apps/${appId}/latest.json`);
  const catalogKey = key("catalog.json");

  const versionsPath = await updateJSONWithCAS({
    bucket,
    key: versionsKey,
    outputDir,
    label: "versions",
    build: async ({ existingPath, attemptDir }) => {
      const baselineReleaseFiles = [];
      const releaseFiles = [];
      if (!existingPath) {
        const baseline = await downloadLegacyBaseline({
          appId,
          bucket,
          catalogKey,
          key,
          outputDir: attemptDir
        });
        if (baseline) baselineReleaseFiles.push(baseline);
      }

      if (releasePath) {
        releaseFiles.push(releasePath);
      } else if (!existingPath && minTuttiVersion) {
        const latest = await getObject({
          bucket,
          key: latestKey,
          outputPath: path.join(attemptDir, "latest.json"),
          required: true
        });
        const latestRelease = JSON.parse(await readFile(latest.path, "utf8"));
        validateRelease(latestRelease);
        const baselineVersion = baselineReleaseFiles.length
          ? JSON.parse(await readFile(baselineReleaseFiles[0], "utf8")).version
          : null;
        if (latestRelease.version !== baselineVersion) {
          releaseFiles.push(latest.path);
        }
      }

      const outputPath = path.join(attemptDir, "versions.json");
      await buildTuttiAppVersions({
        existingVersionsPath: existingPath,
        baselineReleaseFiles,
        releaseFiles,
        ...(releaseFiles.length > 0 ? { minTuttiVersion } : {}),
        outputPath
      });
      return outputPath;
    }
  });

  let latestPath = null;
  if (releasePath) {
    latestPath = await updateJSONWithCAS({
      bucket,
      key: latestKey,
      outputDir,
      label: "latest",
      build: async ({ existingPath, attemptDir }) => {
        const outputPath = path.join(attemptDir, "latest.json");
        await mergeTuttiAppLatest({
          releasePath,
          existingLatestPath: existingPath,
          outputPath
        });
        return outputPath;
      }
    });
  }

  let catalogPath = null;
  if (publishCatalog) {
    catalogPath = await updateJSONWithCAS({
      bucket,
      key: catalogKey,
      outputDir,
      label: "catalog",
      build: async ({ existingPath, attemptDir }) => {
        const outputPath = path.join(attemptDir, "catalog.json");
        await buildTuttiAppCatalog({
          existingCatalogPath: existingPath,
          versionsFiles: [versionsPath],
          outputPath
        });
        return outputPath;
      }
    });
  }

  const stableVersionsPath = path.join(outputDir, "versions.json");
  await copyFile(versionsPath, stableVersionsPath);
  const stableLatestPath = latestPath
    ? path.join(outputDir, "latest.json")
    : null;
  if (latestPath) await copyFile(latestPath, stableLatestPath);
  const stableCatalogPath = catalogPath
    ? path.join(outputDir, "catalog.json")
    : null;
  if (catalogPath) await copyFile(catalogPath, stableCatalogPath);

  return {
    appId,
    versionsPath: stableVersionsPath,
    latestPath: stableLatestPath,
    catalogPath: stableCatalogPath
  };
}

async function downloadLegacyBaseline(input) {
  const catalog = await getObject({
    bucket: input.bucket,
    key: input.catalogKey,
    outputPath: path.join(input.outputDir, "existing-catalog.json"),
    required: false
  });
  if (!catalog) return null;
  const document = JSON.parse(await readFile(catalog.path, "utf8"));
  if ((document.compatibility?.apps?.[input.appId] ?? []).length > 0) {
    throw new Error(
      `versions index for ${input.appId} is missing but catalog compatibility history exists; restore versions.json before publishing`
    );
  }
  const app = document.apps?.find(
    (candidate) => candidate?.manifest?.appId === input.appId
  );
  const version = app?.manifest?.version;
  if (typeof version !== "string" || version.trim() === "") return null;

  const baseline = await getObject({
    bucket: input.bucket,
    key: input.key(`apps/${input.appId}/${version}/release.json`),
    outputPath: path.join(input.outputDir, "baseline-release.json"),
    required: true
  });
  const release = JSON.parse(await readFile(baseline.path, "utf8"));
  validateRelease(release);
  if (release.appId !== input.appId || release.version !== version) {
    throw new Error("legacy baseline release does not match catalog app");
  }
  if (!isDeepStrictEqual(releaseToCatalogApp(release), app)) {
    throw new Error(
      "legacy baseline release projection does not match catalog app"
    );
  }
  return baseline.path;
}

async function updateJSONWithCAS(input) {
  let lastPreconditionError = null;
  for (let attempt = 1; attempt <= maxCASAttempts; attempt += 1) {
    const attemptDir = path.join(input.outputDir, `${input.label}-${attempt}`);
    await mkdir(attemptDir, { recursive: true });
    const existing = await getObject({
      bucket: input.bucket,
      key: input.key,
      outputPath: path.join(attemptDir, "existing.json"),
      required: false
    });
    const outputPath = await input.build({
      existingPath: existing?.path ?? null,
      attemptDir
    });
    try {
      putObject({
        bucket: input.bucket,
        key: input.key,
        path: outputPath,
        etag: existing?.etag ?? null
      });
      return outputPath;
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      lastPreconditionError = error;
    }
  }
  throw new Error(
    `${input.label} metadata changed concurrently after ${maxCASAttempts} attempts: ${lastPreconditionError?.message ?? "precondition failed"}`
  );
}

async function getObject({ bucket, key, outputPath, required }) {
  const head = runAWS(
    ["s3api", "head-object", "--bucket", bucket, "--key", key],
    { allowMissing: !required }
  );
  if (head.missing) return null;
  const metadata = JSON.parse(head.stdout);
  runAWS(["s3api", "get-object", "--bucket", bucket, "--key", key, outputPath]);
  return { path: outputPath, etag: metadata.ETag };
}

function putObject({ bucket, key, path: filePath, etag }) {
  const args = [
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--body",
    filePath,
    "--content-type",
    "application/json",
    "--cache-control",
    "public, max-age=60"
  ];
  if (etag) {
    args.push("--if-match", etag);
  } else {
    args.push("--if-none-match", "*");
  }
  runAWS(args);
}

function runAWS(args, options = {}) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status === 0) {
    return { stdout: result.stdout, missing: false };
  }
  const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (
    options.allowMissing &&
    /(?:404|Not Found|NoSuchKey|NotFound)/iu.test(message)
  ) {
    return { stdout: "", missing: true };
  }
  const error = new Error(
    `aws ${args.slice(0, 2).join(" ")} failed: ${message}`
  );
  error.awsOutput = message;
  throw error;
}

function isPreconditionFailure(error) {
  return /(?:412|PreconditionFailed|precondition)/iu.test(
    error?.awsOutput ?? error?.message ?? ""
  );
}

function requireNonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--publish-catalog") {
      result.publishCatalog = true;
      continue;
    }
    if (arg === "--catalog-only") {
      result.catalogOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      [
        "--app-id",
        "--s3-bucket",
        "--s3-prefix",
        "--release-file",
        "--min-tutti-version",
        "--output-dir"
      ].includes(arg)
    ) {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      const key = {
        "--app-id": "appId",
        "--s3-bucket": "s3Bucket",
        "--s3-prefix": "s3Prefix",
        "--release-file": "releasePath",
        "--min-tutti-version": "minTuttiVersion",
        "--output-dir": "outputDir"
      }[arg];
      result[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

export async function main() {
  const result = await publishTuttiAppMetadata(
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
