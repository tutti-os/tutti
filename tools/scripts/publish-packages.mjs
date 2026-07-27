import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  getNpmReleasePackages,
  workspaceRoot
} from "./npm-release-packages.mjs";
import {
  formatStablePackageReleaseTag,
  parseStablePackageReleaseVersion
} from "./package-release-version.mjs";
import { preparePackageGoModuleReleaseTree } from "./go-module-release.mjs";

// DeviceLink remains an unreleased Personal-first transport spike until the
// Android/Desktop product path proves its authenticated lifecycle.
const provisionalGoModuleDirectories = new Set(["packages/device-link"]);

if (isExecutedAsEntryPoint()) {
  await main();
}

async function main() {
  const expectedVersion = process.argv[2];
  const packages = await getNpmReleasePackages();
  const releaseVersion = await readSharedReleaseVersion(packages);
  const releaseTagNames = await resolveReleaseTagNames(releaseVersion);
  const publishArguments = createPublishArguments({
    withProvenance: readBooleanEnvironmentVariable(
      process.env.TUTTI_NPM_PROVENANCE
    )
  });

  if (expectedVersion && releaseVersion !== expectedVersion) {
    throw new Error(
      `Expected package release version ${expectedVersion}, found ${releaseVersion}`
    );
  }

  for (const tagName of releaseTagNames) {
    if (gitTagExists(tagName)) {
      throw new Error(`Package release tag ${tagName} already exists`);
    }
  }

  const rewrittenGoModules = await preparePackageGoModuleReleaseTree({
    releaseVersion,
    workspaceRoot
  });
  console.log(
    `Prepared ${rewrittenGoModules.length} Go modules for v${releaseVersion}`
  );
  createReleaseCommit(releaseVersion, [
    ...packages.map((packageConfig) => packageConfig.manifestPath),
    ...rewrittenGoModules
  ]);

  for (const packageConfig of packages) {
    if (isPackageVersionPublished(packageConfig.name, releaseVersion)) {
      console.log(
        `Skipping ${packageConfig.name}@${releaseVersion}; version is already published`
      );
      continue;
    }

    console.log(
      `Publishing ${packageConfig.name}@${releaseVersion} with latest tag`
    );
    execFileSync("pnpm", publishArguments, {
      cwd: join(workspaceRoot, packageConfig.directory),
      stdio: "inherit"
    });
  }

  for (const tagName of releaseTagNames) {
    execFileSync("git", ["tag", tagName], {
      cwd: workspaceRoot,
      stdio: "inherit"
    });
  }
  execFileSync("git", ["push", "origin", ...releaseTagNames], {
    cwd: workspaceRoot,
    env: createReleaseGitEnvironment(),
    stdio: "inherit"
  });
}

export function createReleaseCommit(releaseVersion, releasePaths) {
  execFileSync("git", ["add", "--", ...releasePaths], {
    cwd: workspaceRoot,
    stdio: "inherit"
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "--signoff",
      "--message",
      `chore(release): packages v${releaseVersion}`
    ],
    {
      cwd: workspaceRoot,
      env: createReleaseGitEnvironment(),
      stdio: "inherit"
    }
  );
}

async function readSharedReleaseVersion(packages) {
  let version = null;

  for (const packageConfig of packages) {
    const manifestText = await readFile(
      join(workspaceRoot, packageConfig.manifestPath),
      "utf8"
    );
    const manifest = JSON.parse(manifestText);

    if (typeof manifest.version !== "string") {
      throw new Error(
        `${packageConfig.manifestPath} is missing a string version`
      );
    }

    if (!parseStablePackageReleaseVersion(manifest.version)) {
      throw new Error(
        `${packageConfig.manifestPath} has unsupported version ${manifest.version}`
      );
    }

    if (version && version !== manifest.version) {
      throw new Error(
        `Release package versions must match: ${version} !== ${manifest.version}`
      );
    }

    version = manifest.version;
  }

  if (!version) {
    throw new Error("No release package version was found");
  }

  return version;
}

function gitTagExists(tagName) {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`],
      {
        cwd: workspaceRoot,
        stdio: "ignore"
      }
    );
    return true;
  } catch {
    return false;
  }
}

function isExecutedAsEntryPoint() {
  const entrypoint = process.argv[1];

  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}

export function createPublishArguments({ withProvenance }) {
  const arguments_ = [
    "publish",
    "--access",
    "public",
    "--tag",
    "latest",
    "--no-git-checks"
  ];

  if (withProvenance) {
    arguments_.push("--provenance");
  }

  return arguments_;
}

export function createReleaseGitEnvironment() {
  return {
    ...process.env,
    HUSKY: "0"
  };
}

export async function resolveReleaseTagNames(releaseVersion) {
  return [
    formatStablePackageReleaseTag(releaseVersion),
    ...(await resolvePackageGoModuleReleaseTagNames(releaseVersion))
  ];
}

export async function resolvePackageGoModuleReleaseTagNames(releaseVersion) {
  const directories = await discoverPackageGoModuleDirectories();

  return directories.map((directory) =>
    formatPackageGoModuleReleaseTag(directory, releaseVersion)
  );
}

export function formatPackageGoModuleReleaseTag(directory, releaseVersion) {
  if (!parseStablePackageReleaseVersion(releaseVersion)) {
    throw new Error(`Unsupported package release version: ${releaseVersion}`);
  }

  if (!directory.startsWith("packages/")) {
    throw new Error(
      `Go module release directory must be under packages/: ${directory}`
    );
  }

  return `${directory}/v${releaseVersion}`;
}

export function isPublishedVersionListed(publishedVersions, version) {
  return normalizePublishedPackageVersions(publishedVersions).includes(version);
}

export function normalizePublishedPackageVersions(value) {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string");
  }

  return [];
}

function readBooleanEnvironmentVariable(value) {
  if (value === undefined) {
    return false;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(
    `Expected TUTTI_NPM_PROVENANCE to be "true" or "false", received ${JSON.stringify(value)}`
  );
}

async function discoverPackageGoModuleDirectories() {
  const packagesRoot = join(workspaceRoot, "packages");
  const directories = [];

  await collectPackageGoModuleDirectories(packagesRoot, directories);

  return directories
    .filter((directory) => !provisionalGoModuleDirectories.has(directory))
    .sort();
}

async function collectPackageGoModuleDirectories(directory, directories) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isFile() && entry.name === "go.mod") {
      directories.push(toPosixPath(relative(workspaceRoot, directory)));
      continue;
    }

    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }

    await collectPackageGoModuleDirectories(entryPath, directories);
  }
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function isPackageVersionPublished(packageName, version) {
  try {
    const output = execFileSync(
      "npm",
      ["view", packageName, "versions", "--json"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    return isPublishedVersionListed(JSON.parse(output), version);
  } catch (error) {
    const stderr =
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";

    if (
      stderr.includes("E404") ||
      stderr.includes("404 Not Found") ||
      stderr.includes("npm ERR! code E404")
    ) {
      return false;
    }

    throw error;
  }
}
