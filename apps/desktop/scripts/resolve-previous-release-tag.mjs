#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseReleaseTag } from "./lib/releaseConfig.mjs";
import { resolvePreviousReleaseTag } from "./lib/previousReleaseTag.mjs";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (!key.startsWith("--") || !next || next.startsWith("--")) {
      continue;
    }
    args.set(key.slice(2), next);
    index += 1;
  }
  return args;
}

function requireValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function listReleaseTags() {
  return execFileSync(
    "git",
    ["tag", "--list", "v*", "--sort=-version:refname"],
    { encoding: "utf8" }
  )
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv);
  const channel = requireValue(
    args.get("channel") ?? process.env.RELEASE_CHANNEL,
    "channel"
  );
  const tag = requireValue(args.get("tag") ?? process.env.RELEASE_TAG, "tag");
  const version = parseReleaseTag(tag);
  if (!version) {
    throw new Error(`Unsupported desktop release tag: ${tag}`);
  }

  process.stdout.write(
    resolvePreviousReleaseTag({
      channel,
      tag,
      tags: listReleaseTags(),
      version
    })
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
