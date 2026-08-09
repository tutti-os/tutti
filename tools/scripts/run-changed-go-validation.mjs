import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createIsolatedGitEnvironment } from "./git-environment.mjs";
import {
  buildGoLintLane,
  buildGoTestLane,
  discoverGoModuleRoots,
  isBuiltinGenerateRequired,
  resolveGoValidationTargets,
  selectGoLintModuleRoots
} from "./run-check-changed-targets.mjs";
import { runValidationLanes } from "./run-validation-lanes.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

export function buildChangedGoValidationLanes({
  changedFiles,
  kind,
  moduleRoots,
  pathExists,
  pnpmCommand = "pnpm",
  root = workspaceRoot
}) {
  if (kind !== "lint" && kind !== "test") {
    throw new Error("kind requires lint or test");
  }
  const resolved = resolveGoValidationTargets(changedFiles, {
    lintModuleRoots: selectGoLintModuleRoots(moduleRoots),
    moduleRoots,
    ...(pathExists ? { pathExists } : {})
  });
  if (!resolved) {
    return [];
  }
  const targetsByModule =
    kind === "lint" ? resolved.lintByModule : resolved.testByModule;
  const forceBuiltinGenerate = isBuiltinGenerateRequired(changedFiles);
  return Array.from(targetsByModule, ([moduleRoot, targets]) =>
    kind === "lint"
      ? buildGoLintLane({
          forceBuiltinGenerate,
          moduleRoot,
          pnpmCommand,
          shellQuote,
          targets,
          workspaceRoot: root
        })
      : buildGoTestLane({
          forceBuiltinGenerate,
          moduleRoot,
          pnpmCommand,
          shellQuote,
          targets
        })
  );
}

export function parseChangedGoValidationArgs(inputArgs) {
  const args = inputArgs.filter((arg) => arg !== "--");
  const options = {
    baseRef: null,
    headRef: "HEAD",
    kind: null,
    maxParallel: 3,
    tailLines: 80
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--base":
        options.baseRef = readValue(args, ++index, arg);
        break;
      case "--head":
        options.headRef = readValue(args, ++index, arg);
        break;
      case "--kind": {
        const kind = readValue(args, ++index, arg);
        if (kind !== "lint" && kind !== "test") {
          throw new Error("--kind requires lint or test");
        }
        options.kind = kind;
        break;
      }
      case "--max-parallel":
        options.maxParallel = readPositiveInteger(args, ++index, arg);
        break;
      case "--tail-lines":
        options.tailLines = readPositiveInteger(args, ++index, arg);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.baseRef) {
    throw new Error("--base is required");
  }
  if (!options.kind) {
    throw new Error("--kind is required");
  }
  return options;
}

async function main() {
  const options = parseChangedGoValidationArgs(process.argv.slice(2));
  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", `${options.baseRef}...${options.headRef}`],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: createIsolatedGitEnvironment(workspaceRoot)
    }
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const moduleRoots = discoverGoModuleRoots({ root: workspaceRoot });
  const lanes = buildChangedGoValidationLanes({
    changedFiles,
    kind: options.kind,
    moduleRoots
  });
  const label =
    options.kind === "lint" ? "Changed Go lint" : "Changed Go tests";
  const result = await runValidationLanes({
    lanes,
    maxParallel: options.maxParallel,
    summaryLabel: label,
    tailLines: options.tailLines,
    tmpDirectoryName:
      options.kind === "lint" ? "lint-runs/go-changed" : "test-runs/go-changed",
    workspaceRoot
  });
  process.exitCode = result.exitCode;
}

function readValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function readPositiveInteger(args, index, option) {
  const value = readValue(args, index, option);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${option} requires a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
