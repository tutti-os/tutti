#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { claimDesktopRelease } from "./lib/claimDesktopRelease.mjs";

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

function printUsage() {
  process.stderr.write(
    [
      "Usage: node scripts/reserve-release-tag.mjs --strategy <patch|minor|major|patch_rc|minor_rc|major_rc|patch_beta|minor_beta|major_beta|explicit_version|explicit_tag> --target <commit-ish> [options]",
      "",
      "Options:",
      "  --version <x.y.z[-rc.n|-beta.n]>  Release version when using explicit_version",
      "  --tag <tag>               Full release tag when using explicit_tag",
      "  --target <commit-ish>     Commit that the reserved tag should point to",
      "  --max-attempts <n>        Retry budget for auto-calculated versions (default: 20)",
      "  --json                    Emit JSON metadata instead of only the tag",
      ""
    ].join("\n")
  );
}

function fetchRemoteTags() {
  execFileSync("git", ["fetch", "origin", "--force", "--tags"], {
    cwd: appDir,
    stdio: ["ignore", "ignore", "pipe"]
  });
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

function deleteLocalTag(tag) {
  try {
    execFileSync("git", ["tag", "--delete", tag], {
      cwd: appDir,
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {
    return;
  }
}

function reserveRemoteTag(tag, target) {
  deleteLocalTag(tag);

  execFileSync("git", ["tag", tag, target], {
    cwd: appDir,
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    execFileSync(
      "git",
      ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
      {
        cwd: appDir,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    return true;
  } catch (error) {
    deleteLocalTag(tag);
    const stderr =
      error instanceof Error && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    if (
      stderr.includes("[rejected]") ||
      stderr.includes("already exists") ||
      stderr.includes("cannot lock ref")
    ) {
      return false;
    }
    throw error;
  }
}

const args = parseArgs(process.argv);
const strategy = (args.get("strategy") ?? "").trim();
const explicitVersion = (args.get("version") ?? "").trim();
const explicitTag = (args.get("tag") ?? "").trim();
const outputJson = args.has("json");
const target = (args.get("target") ?? "").trim();
const maxAttempts = Number(args.get("max-attempts") ?? "20");

if (!strategy || !target || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
  printUsage();
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const currentVersion =
  typeof packageJson.version === "string" ? packageJson.version.trim() : "";

let release;
try {
  release = await claimDesktopRelease({
    currentVersion,
    explicitTag,
    explicitVersion,
    listTags: async () => {
      fetchRemoteTags();
      return readGitTags();
    },
    maxAttempts,
    reserveTag: async (tag) => reserveRemoteTag(tag, target),
    strategy
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
