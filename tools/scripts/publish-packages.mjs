import { execFile, execFileSync, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  getNpmReleasePackages,
  workspaceRoot
} from "./npm-release-packages.mjs";
import {
  formatStablePackageReleaseTag,
  parseStablePackageReleaseVersion
} from "./package-release-version.mjs";
import { preparePackageGoModuleReleaseTree } from "./go-module-release.mjs";

const execFileAsync = promisify(execFile);
const defaultPackagePublishConcurrency = 4;
const maximumPackagePublishConcurrency = 8;

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
  const publishConcurrency = resolvePackagePublishConcurrency(
    process.env.TUTTI_NPM_PUBLISH_CONCURRENCY
  );

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

  console.log(
    `Publishing ${packages.length} packages with concurrency ${publishConcurrency}`
  );
  await publishPackageGroup({
    concurrency: publishConcurrency,
    isPublished: isPackageVersionPublished,
    packages,
    publish: (packageConfig) =>
      runCommand("pnpm", publishArguments, {
        cwd: join(workspaceRoot, packageConfig.directory)
      }),
    releaseVersion
  });

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

// npm provenance can fail after creating a transparency-log entry but before
// the registry accepts the package. Re-checking the immutable version before
// a bounded retry makes workflow re-runs and this individual publish step
// idempotent without disabling provenance.
export async function publishPackageWithRetry({
  packageName,
  version,
  publish,
  isPublished,
  maxAttempts = 3,
  wait = defaultPublishRetryWait
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await publish();
      return;
    } catch (error) {
      lastError = error;
      if (await isPublished()) {
        console.log(
          `${packageName}@${version} became visible after publish returned an error; continuing`
        );
        return;
      }
      if (attempt < maxAttempts) {
        console.warn(
          `Publish attempt ${attempt}/${maxAttempts} failed for ${packageName}@${version}; retrying`
        );
        await wait(attempt);
      }
    }
  }
  throw lastError;
}

export async function publishPackageGroup({
  concurrency,
  isPublished,
  packages,
  publish,
  releaseVersion
}) {
  await runWithConcurrency(packages, concurrency, async (packageConfig) => {
    if (await isPublished(packageConfig.name, releaseVersion)) {
      console.log(
        `Skipping ${packageConfig.name}@${releaseVersion}; version is already published`
      );
      return;
    }

    await publishPackageWithRetry({
      packageName: packageConfig.name,
      version: releaseVersion,
      publish: async () => {
        console.log(
          `Publishing ${packageConfig.name}@${releaseVersion} with latest tag`
        );
        await publish(packageConfig);
      },
      isPublished: () => isPublished(packageConfig.name, releaseVersion)
    });
  });
}

export async function runWithConcurrency(items, concurrency, task) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }

  let nextIndex = 0;
  let failed = false;
  let firstError;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      try {
        await task(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  });

  await Promise.all(workers);

  if (failed) {
    throw firstError;
  }
}

export function resolvePackagePublishConcurrency(value) {
  if (value === undefined) {
    return defaultPackagePublishConcurrency;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `TUTTI_NPM_PUBLISH_CONCURRENCY must be an integer from 1 to ${maximumPackagePublishConcurrency}`
    );
  }

  const concurrency = Number(value);
  if (concurrency < 1 || concurrency > maximumPackagePublishConcurrency) {
    throw new Error(
      `TUTTI_NPM_PUBLISH_CONCURRENCY must be an integer from 1 to ${maximumPackagePublishConcurrency}`
    );
  }

  return concurrency;
}

function defaultPublishRetryWait(attempt) {
  return new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
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

export function createPublishedVersionViewArguments(packageName, version) {
  return ["view", `${packageName}@${version}`, "version", "--json"];
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

  return directories.sort();
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

async function isPackageVersionPublished(packageName, version) {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      createPublishedVersionViewArguments(packageName, version),
      {
        cwd: workspaceRoot,
        encoding: "utf8"
      }
    );

    return isPublishedVersionListed(JSON.parse(stdout), version);
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

function runCommand(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    let outputFlushed = false;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      outputChunks.push([process.stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      outputChunks.push([process.stderr, chunk]);
    });

    const flushOutput = () => {
      if (outputFlushed) {
        return;
      }
      outputFlushed = true;
      for (const [stream, chunk] of outputChunks) {
        stream.write(chunk);
      }
    };

    child.once("error", (error) => {
      flushOutput();
      reject(error);
    });
    child.once("close", (code, signal) => {
      flushOutput();
      if (code === 0) {
        resolve();
        return;
      }

      const termination = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(
        new Error(`${command} ${args.join(" ")} failed with ${termination}`)
      );
    });
  });
}
