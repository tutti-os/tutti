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
  const toolTests = trackedFiles
    .filter(
      (file) => file.startsWith("tools/scripts/") && file.endsWith(".test.mjs")
    )
    .sort();
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

  if (toolTests.length === 0) {
    errors.push("tools/scripts contains no *.test.mjs files");
  }

  packages.sort((left, right) => left.root.localeCompare(right.root));
  return { errors, packages, toolTests };
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
