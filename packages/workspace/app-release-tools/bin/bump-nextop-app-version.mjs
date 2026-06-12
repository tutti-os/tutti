#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateManifest } from "./build-nextop-app-release.mjs";

const allowedBumps = new Set(["major", "minor", "patch"]);

export async function bumpNextopAppVersion(options) {
  const manifestPath = path.resolve(
    requireNonEmpty(options.manifestPath, "manifestPath")
  );
  const bump = String(options.bump ?? "patch").trim();
  if (!allowedBumps.has(bump)) {
    throw new Error("bump must be one of major, minor, or patch");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, manifestPath);
  if (options.appId && manifest.appId !== options.appId) {
    throw new Error(
      `appId mismatch: input ${options.appId} does not match manifest ${manifest.appId}`
    );
  }

  const previousVersion = manifest.version;
  const version = bumpStableVersion(previousVersion, bump);
  manifest.version = version;
  validateManifest(manifest, manifestPath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    appId: manifest.appId,
    manifestPath,
    previousVersion,
    version
  };
}

function bumpStableVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim());
  if (!match) {
    throw new Error(
      `manifest version must be stable semver x.y.z for automatic bump, got ${JSON.stringify(version)}`
    );
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

function requireNonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (text === "") {
    throw new Error(`${label} is required`);
  }
  return text;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-id") {
      result.appId = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--bump") {
      result.bump = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      result.manifestPath = readArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

function readArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

export async function main() {
  const result = await bumpNextopAppVersion(parseArgs(process.argv.slice(2)));
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
