#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDesktopRelease } from "./lib/resolveDesktopRelease.mjs";

const appDir = resolve(import.meta.dirname, "..");
const packageJsonPath = resolve(appDir, "package.json");

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key.slice(2), "true");
      continue;
    }

    args.set(key.slice(2), next);
    index += 1;
  }
  return args;
}

function readGitTags() {
  const raw = execFileSync("git", ["tag", "--list"], {
    cwd: appDir,
    encoding: "utf8"
  });
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function printUsage() {
  process.stderr.write(
    [
      "Usage: node scripts/resolve-release-tag.mjs --strategy <patch|minor|major|patch_rc|minor_rc|major_rc|patch_beta|minor_beta|major_beta|explicit_version|explicit_tag> [options]",
      "",
      "Options:",
      "  --version <x.y.z[-rc.n|-beta.n]>  Release version when using explicit_version",
      "  --tag <tag>        Full release tag when using explicit_tag",
      "  --json             Emit JSON metadata instead of only the tag",
      ""
    ].join("\n")
  );
}

const args = parseArgs(process.argv);
const strategy = (args.get("strategy") ?? "").trim();
const explicitVersion = (args.get("version") ?? "").trim();
const explicitTag = (args.get("tag") ?? "").trim();
const outputJson = args.has("json");

if (!strategy) {
  printUsage();
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const currentVersion =
  typeof packageJson.version === "string" ? packageJson.version.trim() : "";

let release;
try {
  release = resolveDesktopRelease({
    currentVersion,
    explicitTag,
    explicitVersion,
    strategy,
    tags: readGitTags()
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  printUsage();
  process.exit(1);
}

if (outputJson) {
  process.stdout.write(JSON.stringify(release));
} else {
  process.stdout.write(`${release.tag}\n`);
}
