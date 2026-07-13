#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { validateRelease } from "./build-tutti-app-release.mjs";
import { compareReleaseVersions } from "./tutti-app-versioning.mjs";

export async function mergeTuttiAppLatest(options) {
  const releasePath = path.resolve(String(options.releasePath));
  const outputPath = path.resolve(String(options.outputPath));
  const release = JSON.parse(await readFile(releasePath, "utf8"));
  validateRelease(release);

  let latest = release;
  if (options.existingLatestPath) {
    const existing = JSON.parse(
      await readFile(path.resolve(String(options.existingLatestPath)), "utf8")
    );
    validateRelease(existing);
    if (existing.appId !== release.appId) {
      throw new Error("existing latest appId must match release appId");
    }
    if (compareReleaseVersions(existing, release) > 0) {
      latest = existing;
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(latest, null, 2)}\n`);
  return { outputPath, latest };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (["--release-file", "--existing-latest", "--output"].includes(arg)) {
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      if (arg === "--release-file") result.releasePath = value;
      if (arg === "--existing-latest") result.existingLatestPath = value;
      if (arg === "--output") result.outputPath = value;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!result.releasePath || !result.outputPath) {
    throw new Error("--release-file and --output are required");
  }
  return result;
}

export async function main() {
  const result = await mergeTuttiAppLatest(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.latest, null, 2)}\n`);
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
