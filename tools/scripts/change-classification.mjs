import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { selectedRepositoryCheckGroups } from "./repository-checks.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../..");

export function classifyChangedFiles(
  changedFiles,
  { releasePackageRoots = discoverReleasePackageRoots() } = {}
) {
  const normalizedFiles = changedFiles.map((file) =>
    file.replaceAll("\\", "/")
  );
  const groups = selectedRepositoryCheckGroups(normalizedFiles);

  return {
    runBoundaries: groups.has("boundaries"),
    runContracts: groups.has("contracts"),
    runGenerated: groups.has("generated"),
    runGo: normalizedFiles.some(isGoRelevant),
    runPack: normalizedFiles.some((file) =>
      isPackRelevant(file, releasePackageRoots)
    ),
    runTs: normalizedFiles.some(isTypeScriptRelevant)
  };
}

export function discoverReleasePackageRoots(root = workspaceRoot) {
  const packagesRoot = join(root, "packages");
  const roots = [];

  for (const group of readDirectories(packagesRoot)) {
    const groupRoot = join(packagesRoot, group);
    for (const packageName of readDirectories(groupRoot)) {
      const packageRoot = join(groupRoot, packageName);
      const manifestPath = join(packageRoot, "package.json");
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (
          manifest.private === false &&
          manifest.publishConfig?.access === "public"
        ) {
          roots.push(packageRoot.slice(root.length + 1).replaceAll("\\", "/"));
        }
      } catch {
        // Non-package directories are outside the release surface.
      }
    }
  }

  return roots.sort();
}

export function formatClassificationOutputs(classification) {
  return [
    ["run_boundaries", classification.runBoundaries],
    ["run_contracts", classification.runContracts],
    ["run_generated", classification.runGenerated],
    ["run_go", classification.runGo],
    ["run_pack", classification.runPack],
    ["run_ts", classification.runTs]
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function isGoRelevant(file) {
  return (
    file.endsWith(".go") ||
    /(?:^|\/)go\.(?:mod|sum)$/u.test(file) ||
    ["go.work", "go.work.sum"].includes(file) ||
    file.startsWith("services/tuttid/.golangci")
  );
}

function isTypeScriptRelevant(file) {
  return (
    /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file) ||
    /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/u.test(file) ||
    ["pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) ||
    file.startsWith("packages/configs/")
  );
}

function isPackRelevant(file, releasePackageRoots) {
  return (
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) ||
    /^packages\/[^/]+\/[^/]+\/package\.json$/u.test(file) ||
    file === ".changeset/config.json" ||
    file === "tools/scripts/build-npm-packages.mjs" ||
    file === "tools/scripts/check-package-packs.mjs" ||
    file === "tools/scripts/npm-release-packages.mjs" ||
    releasePackageRoots.some(
      (packageRoot) =>
        file === packageRoot || file.startsWith(`${packageRoot}/`)
    )
  );
}

function readDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  const base = readOption("--base");
  if (!base) {
    throw new Error("--base is required");
  }
  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...HEAD`],
    { cwd: workspaceRoot, encoding: "utf8" }
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const output = formatClassificationOutputs(
    classifyChangedFiles(changedFiles)
  );
  const githubOutput = readOption("--github-output");
  if (githubOutput) {
    writeFileSync(githubOutput, `${output}\n`, { flag: "a" });
  }
  console.log(output);
}
