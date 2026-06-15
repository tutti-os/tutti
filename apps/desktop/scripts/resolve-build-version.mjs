#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveDesktopBuildVersion } from "./lib/desktopBuildVersion.mjs";

const appDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appDir, "../..");
const packageJsonPath = resolve(appDir, "package.json");

function readGitDescribeVersion() {
  try {
    return execFileSync(
      "git",
      [
        "describe",
        "--tags",
        "--match",
        "v*",
        "--match",
        "tutti-desktop-v*",
        "--always",
        "--dirty"
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).trim();
  } catch {
    return "";
  }
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const fallbackVersion =
  typeof packageJson.version === "string" ? packageJson.version : "";

const version = resolveDesktopBuildVersion({
  describeVersion: readGitDescribeVersion(),
  fallbackVersion,
  releaseTag: process.env.TUTTI_DESKTOP_RELEASE_TAG
});

if (!version) {
  process.stderr.write("Could not resolve desktop build version\n");
  process.exit(1);
}

process.stdout.write(`${version}\n`);
