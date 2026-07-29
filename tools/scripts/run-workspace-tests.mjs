import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPositiveIntegerOption,
  runValidationLanes
} from "./run-validation-lanes.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

if (isMainModule()) {
  const toolsOnly = process.argv.includes("--tools-only");
  const packageNames = parseWorkspaceTestPackageFilters(process.argv.slice(2));
  const shard = parseWorkspaceTestShard(process.argv.slice(2));
  const trackedFiles = gitLines([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard"
  ]).filter((path) => existsSync(join(workspaceRoot, path)));
  const packageJsonPaths = gitLines([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "apps/*/package.json",
    "packages/*/*/package.json",
    "services/tuttid/builtin-apps/*/package.json",
    "tools/fixtures/*/package.json"
  ]).filter((path) => existsSync(join(workspaceRoot, path)));
  const plan = buildWorkspaceTestPlan({
    packageJsonEntries: packageJsonPaths.map((path) => ({
      path,
      value: JSON.parse(readFileSync(join(workspaceRoot, path), "utf8"))
    })),
    toolsOnly,
    trackedFiles
  });
  const packageSelection = selectWorkspaceTestPackages(
    plan.packages,
    packageNames
  );
  plan.errors.push(...packageSelection.errors);
  plan.packages = shardWorkspaceTestPackages(packageSelection.packages, shard);

  if (plan.errors.length > 0) {
    for (const error of plan.errors) {
      console.error(error);
    }
    process.exit(1);
  }

  const pnpmCommand = resolvePnpmCommand();
  const lanes = plan.packages.map((packageInfo) => ({
    command: [...pnpmCommand, "--filter", packageInfo.name, "test"],
    key: packageInfo.name,
    label: packageInfo.name
  }));
  if (plan.toolTests.length > 0) {
    lanes.push({
      command: [process.execPath, "--test", ...plan.toolTests],
      key: "tools",
      label: "tools"
    });
  }

  const result = await runValidationLanes({
    lanes,
    maxParallel: readPositiveIntegerOption(
      "--max-parallel",
      process.env.CI ? 1 : 4
    ),
    summaryLabel: toolsOnly ? "tool tests" : "workspace tests",
    tailLines: readPositiveIntegerOption("--tail-lines", 80),
    tmpDirectoryName: "test-runs/typescript",
    workspaceRoot
  });
  process.exit(result.exitCode);
}

export function buildWorkspaceTestPlan({
  packageJsonEntries,
  toolsOnly,
  trackedFiles
}) {
  const testFilePattern = /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/u;
  const toolTests = toolsOnly
    ? trackedFiles
        .filter(
          (file) =>
            file.startsWith("tools/scripts/") && file.endsWith(".test.mjs")
        )
        .sort()
    : [];
  const packages = [];
  const errors = [];

  if (!toolsOnly) {
    for (const entry of packageJsonEntries) {
      const name = entry.value.name;
      const testScript = entry.value.scripts?.test;
      if (!name || !testScript) {
        continue;
      }
      const root = dirname(entry.path).replaceAll("\\", "/");
      const packageTestFiles = trackedFiles.filter(
        (file) => file.startsWith(`${root}/`) && testFilePattern.test(file)
      );
      if (packageTestFiles.length === 0) {
        errors.push(
          `${name} declares a test script but has no package test files; add a *.test.*/*.spec.* file or remove the stale script`
        );
        continue;
      }
      packages.push({ name, root, testFileCount: packageTestFiles.length });
    }
  }

  if (toolsOnly && toolTests.length === 0) {
    errors.push("tools/scripts contains no *.test.mjs files");
  }

  packages.sort((left, right) => left.root.localeCompare(right.root));
  return { errors, packages, toolTests };
}

export function parseWorkspaceTestPackageFilters(args) {
  let packageNames = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" || arg === "--tools-only") {
      continue;
    }
    if (arg === "--max-parallel" || arg === "--tail-lines") {
      index += 1;
      continue;
    }
    if (arg === "--shard") {
      index += 1;
      continue;
    }
    if (arg !== "--packages-json" || packageNames !== null) {
      throw new Error(`unknown workspace test option: ${arg}`);
    }
    try {
      packageNames = JSON.parse(args[++index] ?? "");
    } catch {
      throw new Error("--packages-json must contain valid JSON");
    }
  }
  if (packageNames === null) {
    return null;
  }
  if (
    !Array.isArray(packageNames) ||
    packageNames.length === 0 ||
    packageNames.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error("--packages-json must contain a non-empty string array");
  }
  return [...new Set(packageNames)];
}

export function parseWorkspaceTestShard(args) {
  let shard = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--shard") {
      if (shard !== null) {
        throw new Error("--shard may only be provided once");
      }
      const value = args[++index] ?? "";
      const match = /^(\d+)\/(\d+)$/u.exec(value);
      if (!match) {
        throw new Error("--shard must use the positive index/total format");
      }
      const indexValue = Number.parseInt(match[1], 10);
      const total = Number.parseInt(match[2], 10);
      if (indexValue < 1 || total < 1 || indexValue > total) {
        throw new Error("--shard index must be between 1 and its total");
      }
      shard = { index: indexValue, total };
      continue;
    }
    if (arg === "--" || arg === "--tools-only" || arg === "--packages-json") {
      if (arg === "--packages-json") {
        index += 1;
      }
      continue;
    }
    if (arg === "--max-parallel" || arg === "--tail-lines") {
      index += 1;
      continue;
    }
  }
  return shard;
}

export function selectWorkspaceTestPackages(packages, packageNames) {
  if (packageNames === null) {
    return { errors: [], packages };
  }

  const selectedNames = new Set(packageNames);
  const packageNameSet = new Set(
    packages.map((packageConfig) => packageConfig.name)
  );
  const unknownNames = packageNames.filter((name) => !packageNameSet.has(name));
  return {
    errors:
      unknownNames.length === 0
        ? []
        : [
            `Unknown workspace test package filter(s): ${unknownNames.join(", ")}`
          ],
    packages: packages.filter((packageConfig) =>
      selectedNames.has(packageConfig.name)
    )
  };
}

export function shardWorkspaceTestPackages(packages, shard) {
  if (shard === null) {
    return packages;
  }

  const buckets = Array.from({ length: shard.total }, () => ({
    packageNames: new Set(),
    testFileCount: 0
  }));
  const packagesByWeight = packages
    .map((packageConfig, index) => ({ index, packageConfig }))
    .sort(
      (left, right) =>
        (right.packageConfig.testFileCount ?? 1) -
          (left.packageConfig.testFileCount ?? 1) || left.index - right.index
    );

  for (const { packageConfig } of packagesByWeight) {
    const bucket = buckets.reduce((lightest, candidate) =>
      candidate.testFileCount < lightest.testFileCount ? candidate : lightest
    );
    bucket.packageNames.add(packageConfig.name);
    bucket.testFileCount += packageConfig.testFileCount ?? 1;
  }

  const selectedNames = buckets[shard.index - 1].packageNames;
  return packages.filter((packageConfig) =>
    selectedNames.has(packageConfig.name)
  );
}

function gitLines(args) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolvePnpmCommand() {
  const fallback = [process.platform === "win32" ? "pnpm.cmd" : "pnpm"];
  try {
    const packageJson = JSON.parse(
      readFileSync(join(workspaceRoot, "package.json"), "utf8")
    );
    const match = /^pnpm@(.+)$/u.exec(String(packageJson.packageManager ?? ""));
    if (!match) {
      return fallback;
    }
    return [
      process.platform === "win32" ? "corepack.cmd" : "corepack",
      `pnpm@${match[1]}`
    ];
  } catch {
    return fallback;
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}
