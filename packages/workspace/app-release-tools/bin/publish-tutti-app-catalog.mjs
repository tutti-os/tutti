#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { buildTuttiAppCatalog } from "./build-tutti-app-catalog.mjs";
import { publishTuttiAppMetadata } from "./publish-tutti-app-metadata.mjs";

export async function publishTuttiAppCatalog(options) {
  const appIds = [...new Set(options.appIds ?? [])]
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort();
  if (appIds.length === 0) throw new Error("at least one appId is required");
  const bucket = requireNonEmpty(options.s3Bucket, "s3Bucket");
  const prefix = String(options.s3Prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/gu, "");
  const mode = options.mode ?? "merge";
  if (mode !== "merge" && mode !== "replace") {
    throw new Error("mode must be merge or replace");
  }
  const outputDir = path.resolve(
    String(options.outputDir ?? "tutti-app-catalog")
  );
  await mkdir(outputDir, { recursive: true });
  const key = (suffix) => (prefix ? `${prefix}/${suffix}` : suffix);
  const catalogKey = key("catalog.json");

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const attemptDir = path.join(outputDir, `attempt-${attempt}`);
    await mkdir(attemptDir, { recursive: true });
    const existing = await getObject({
      bucket,
      key: catalogKey,
      outputPath: path.join(attemptDir, "existing-catalog.json"),
      required: false
    });
    const versionsFiles = [];
    for (const appId of appIds) {
      let versions = await getObject({
        bucket,
        key: key(`apps/${appId}/versions.json`),
        outputPath: path.join(attemptDir, `${appId}-versions.json`),
        required: false
      });
      if (!versions) {
        await publishTuttiAppMetadata({
          appId,
          s3Bucket: bucket,
          s3Prefix: prefix,
          catalogOnly: true,
          publishCatalog: false,
          outputDir: path.join(attemptDir, `${appId}-bootstrap`)
        });
        versions = await getObject({
          bucket,
          key: key(`apps/${appId}/versions.json`),
          outputPath: path.join(attemptDir, `${appId}-versions.json`),
          required: true
        });
      }
      versionsFiles.push(versions.path);
    }

    const catalogPath = path.join(attemptDir, "catalog.json");
    await buildTuttiAppCatalog({
      existingCatalogPath: mode === "merge" ? existing?.path : null,
      versionsFiles,
      outputPath: catalogPath
    });
    try {
      putObject({
        bucket,
        key: catalogKey,
        path: catalogPath,
        etag: existing?.etag ?? null
      });
      const stablePath = path.join(outputDir, "catalog.json");
      await copyFile(catalogPath, stablePath);
      return { catalogPath: stablePath, appIds, mode };
    } catch (error) {
      if (!/(?:412|PreconditionFailed|precondition)/iu.test(error.message)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw new Error(
    `catalog changed concurrently: ${lastError?.message ?? "failed"}`
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
    "public, max-age=60",
    ...(etag ? ["--if-match", etag] : ["--if-none-match", "*"])
  ];
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
  throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${message}`);
}

function requireNonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function parseArgs(argv) {
  const result = { appIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (
      [
        "--app-id",
        "--s3-bucket",
        "--s3-prefix",
        "--mode",
        "--output-dir"
      ].includes(arg)
    ) {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      if (arg === "--app-id") result.appIds.push(value);
      if (arg === "--s3-bucket") result.s3Bucket = value;
      if (arg === "--s3-prefix") result.s3Prefix = value;
      if (arg === "--mode") result.mode = value;
      if (arg === "--output-dir") result.outputDir = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

export async function main() {
  const result = await publishTuttiAppCatalog(parseArgs(process.argv.slice(2)));
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
