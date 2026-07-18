import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TYPESCRIPT_CODE_PATTERN = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const TYPESCRIPT_CONFIG_PATTERN = /(?:^|\/)tsconfig[^/]*\.json$/u;
const GO_MODULE_PATTERN = /(?:^|\/)go\.(?:mod|sum)$/u;

export function classifyChangedFiles(changedFiles) {
  const classification = {
    runGo: false,
    runPack: false,
    runTooling: false,
    runTs: false
  };

  for (const rawPath of changedFiles) {
    const path = rawPath.replaceAll("\\", "/");
    if (!path) {
      continue;
    }

    if (isGoPath(path)) {
      classification.runGo = true;
      classification.runTooling = true;
    }

    if (isTypeScriptPath(path)) {
      classification.runTs = true;
      classification.runPack = true;
    }

    if (isPackagePackPath(path)) {
      classification.runPack = true;
    }

    if (isConservativeToolingPath(path)) {
      classification.runGo = true;
      classification.runPack = true;
      classification.runTooling = true;
      classification.runTs = true;
    }
  }

  return classification;
}

export function formatGitHubOutput(classification) {
  return [
    `run_go=${classification.runGo}`,
    `run_pack=${classification.runPack}`,
    `run_tooling=${classification.runTooling}`,
    `run_ts=${classification.runTs}`
  ].join("\n");
}

export function formatClassificationSummary(classification) {
  return `change classification: ${formatGitHubOutput(classification).replaceAll("\n", " ")}`;
}

function isGoPath(path) {
  return (
    path.endsWith(".go") ||
    GO_MODULE_PATTERN.test(path) ||
    path === "go.work" ||
    path === "go.work.sum" ||
    path.startsWith("services/tuttid/.golangci")
  );
}

function isTypeScriptPath(path) {
  return (
    TYPESCRIPT_CODE_PATTERN.test(path) ||
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path === "pnpm-workspace.yaml" ||
    TYPESCRIPT_CONFIG_PATTERN.test(path) ||
    path.startsWith("packages/configs/")
  );
}

function isPackagePackPath(path) {
  if (
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path === "pnpm-workspace.yaml"
  ) {
    return true;
  }
  const segments = path.split("/");
  return (
    segments[0] === "packages" &&
    segments.at(-1) === "package.json" &&
    (segments.length === 3 || segments.length === 4)
  );
}

function isConservativeToolingPath(path) {
  return (
    path === ".github/workflows/pr-checks.yml" ||
    path.startsWith("tools/scripts/") ||
    path === "services/tuttid/.golangci-lint-version"
  );
}

function listChangedFiles(baseRef) {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", `${baseRef}...HEAD`],
    {
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "unable to list changed files");
  }
  return result.stdout.split("\n").filter(Boolean);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function main() {
  const baseRef = readOption("--base");
  if (!baseRef) {
    throw new Error(
      "usage: node tools/scripts/change-classification.mjs --base <ref> [--github-output <path>]"
    );
  }

  const classification = classifyChangedFiles(listChangedFiles(baseRef));
  const githubOutput = formatGitHubOutput(classification);
  const githubOutputPath = readOption("--github-output");
  if (githubOutputPath) {
    appendFileSync(githubOutputPath, `${githubOutput}\n`);
  }
  console.log(formatClassificationSummary(classification));
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
