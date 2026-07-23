import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaneInputFingerprint,
  laneFingerprintVersion,
  LaneCacheError,
  mergeLaneResults,
  resolveRetryPushReady,
  selectFailedOnlyLanes
} from "./run-check-changed-cache.mjs";
import {
  buildGoLintLane,
  buildGoTestLane,
  buildPackageTestCommand,
  isBuiltinGenerateRequired,
  resolveGoModuleRoot,
  resolveGoValidationTargets
} from "./run-check-changed-targets.mjs";
import { classifyChangedFiles } from "./change-classification.mjs";
import {
  selectRepositoryCheckInputs,
  selectRepositoryChecks
} from "./repository-checks.mjs";
import { formatFailureExcerpt } from "./run-validation-lanes.mjs";
import { resolveGolangciLintBinary } from "./golangci-lint-tool.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const golangciLintBinary = resolveGolangciLintBinary({ cwd: workspaceRoot });
const pnpmCommand = resolvePnpmCommand();
const pnpmShellCommand = formatCommand(pnpmCommand);
let maxParallel = 4;
let tailLines = 80;
let dryRun = false;
let failedOnly = false;
let pushReady = false;
let verbose = false;
let baseRef = resolveDefaultBaseRef();
const tmpRoot = join(workspaceRoot, ".tmp", "check-runs");
const latestSummaryPath = join(tmpRoot, "latest.json");

const packageInfos = loadPackageInfos();

export async function main() {
  const previousSummary = failedOnly ? readLatestSummary() : null;
  if (failedOnly && !previousSummary) {
    console.log("check:changed found no previous run to reuse");
    return;
  }
  pushReady = resolveRetryPushReady(pushReady, previousSummary);

  const plannedLanes = buildChangedLanes();

  if (plannedLanes.length === 0) {
    console.log("check:changed found no changed files to validate");
    return;
  }

  if (dryRun && !failedOnly) {
    printPlan(plannedLanes);
    return;
  }

  const currentLanes = plannedLanes.map((lane) => ({
    ...lane,
    inputFingerprint: buildLaneInputFingerprint({
      baseRef,
      lane,
      workspaceRoot
    })
  }));

  const failedOnlySelection = previousSummary
    ? selectFailedOnlyLanes(currentLanes, previousSummary)
    : null;
  const lanesToRun = failedOnlySelection?.lanesToRun ?? currentLanes;
  const reusedResults = failedOnlySelection?.reusedResults ?? [];

  if (dryRun) {
    printPlan(lanesToRun, reusedResults);
    return;
  }

  if (lanesToRun.length === 0) {
    console.log(
      `check:changed found no failed or changed lanes; reused ${reusedResults.length} passed lane(s)`
    );
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = join(tmpRoot, runId);
  mkdirSync(runDirectory, { recursive: true });

  if (verbose) {
    console.log(`check:changed running ${lanesToRun.length} lane(s)`);
    if (reusedResults.length > 0) {
      console.log(
        `check:changed reusing ${reusedResults.length} passed lane(s)`
      );
    }
    console.log(`logs: ${relative(workspaceRoot, runDirectory)}`);
  }

  const startedAt = Date.now();
  const executedResults = await runLanes(lanesToRun, runDirectory);
  const results = mergeLaneResults(
    currentLanes,
    executedResults,
    reusedResults
  );
  const durationMs = Date.now() - startedAt;
  const summary = {
    baseRef,
    durationMs,
    executedLaneCount: executedResults.length,
    failedOnly,
    laneFingerprintVersion,
    pushReady,
    reusedLaneCount: reusedResults.length,
    runDirectory,
    startedAt: new Date(startedAt).toISOString(),
    tailLines,
    results
  };
  writeFileSync(
    join(runDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(latestSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const failures = results.filter((result) => result.exitCode !== 0);
  printSummary(results, failures, durationMs, runDirectory);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

function buildChangedLanes() {
  const changedFiles = listChangedFiles(baseRef);
  const classification = classifyChangedFiles(changedFiles);
  const lanesByKey = new Map();
  const addLane = (lane) => {
    const normalizedInputs = Array.from(new Set(lane.inputFiles)).sort();
    const existing = lanesByKey.get(lane.key);
    if (existing) {
      existing.inputFiles = Array.from(
        new Set([...existing.inputFiles, ...normalizedInputs])
      ).sort();
    } else {
      lanesByKey.set(lane.key, {
        ...lane,
        inputFiles: normalizedInputs
      });
    }
  };

  if (changedFiles.length === 0) {
    return [];
  }

  addLane({
    key: "diff-check",
    label: "diff-check",
    command: [
      "bash",
      "-lc",
      `git diff --check ${shellQuote(baseRef)}...HEAD && git diff --check && git diff --cached --check`
    ],
    inputFiles: changedFiles
  });

  const lintFiles = classification.runTs
    ? selectExistingLintFiles(changedFiles)
    : [];
  if (lintFiles.length > 0) {
    addLane({
      key: "lint:changed",
      label: "lint:changed",
      command: [
        ...pnpmCommand,
        "exec",
        "oxlint",
        "--deny-warnings",
        ...lintFiles
      ],
      inputFiles: lintFiles
    });
  }

  for (const check of selectRepositoryChecks(changedFiles)) {
    addLane({
      key: check.key,
      label: check.label,
      command: [...pnpmCommand, "run", check.script],
      inputFiles: selectRepositoryCheckInputs(check, changedFiles)
    });
  }

  const goValidationTargets = classification.runGo
    ? resolveGoValidationTargets(changedFiles)
    : null;
  const forceBuiltinGenerate = isBuiltinGenerateRequired(changedFiles);
  if (goValidationTargets) {
    for (const [moduleRoot, targets] of goValidationTargets.lintByModule) {
      const inputFiles = selectGoLaneInputs(
        changedFiles,
        moduleRoot,
        forceBuiltinGenerate
      );
      addLane({
        ...buildGoLintLane({
          golangciLintBinary,
          moduleRoot,
          targets,
          shellQuote,
          workspaceRoot
        }),
        inputFiles
      });
    }
    for (const [moduleRoot, targets] of goValidationTargets.testByModule) {
      const inputFiles = selectGoLaneInputs(
        changedFiles,
        moduleRoot,
        forceBuiltinGenerate
      );
      addLane({
        ...buildGoTestLane({
          forceBuiltinGenerate,
          moduleRoot,
          pnpmCommand: pnpmShellCommand,
          shellQuote,
          targets
        }),
        inputFiles
      });
    }

    if (pushReady) {
      addLane({
        key: "build:go",
        label: "build:go",
        command: [...pnpmCommand, "run", "build:go"],
        inputFiles: changedFiles.filter(isGoValidationInput)
      });
    }
  }

  const rootGlobalChange =
    classification.runTs && changedFiles.some(isGlobalTypecheckRelevant);
  if (rootGlobalChange) {
    addLane({
      key: "typecheck:all",
      label: "typecheck:all",
      command: [process.execPath, "./tools/scripts/run-typecheck.mjs"],
      inputFiles: changedFiles.filter(isTypeScriptValidationInput)
    });
  }

  for (const packageInfo of packageInfos) {
    const packageFiles = changedFiles.filter((file) =>
      file.startsWith(`${packageInfo.root}/`)
    );
    if (packageFiles.length === 0) {
      continue;
    }

    const hasRelevantCode = packageFiles.some(isPackageValidationRelevant);
    if (hasRelevantCode && packageInfo.scripts.typecheck && !rootGlobalChange) {
      addLane({
        key: `${packageInfo.name}:typecheck`,
        label: `${packageInfo.name}:typecheck`,
        command: [
          process.execPath,
          "./tools/scripts/run-tsgo-typecheck.mjs",
          "--package-root",
          packageInfo.root
        ],
        inputFiles: packageFiles
      });
    }

    if (hasRelevantCode && packageInfo.scripts.test) {
      const command = buildPackageTestCommand({
        baseRef,
        packageFiles,
        packageInfo,
        pnpmCommand
      });
      if (command) {
        addLane({
          key: `${packageInfo.name}:test`,
          label: `${packageInfo.name}:test`,
          command,
          inputFiles: packageFiles
        });
      }
    }

    if (
      pushReady &&
      !classification.runPack &&
      packageInfo.scripts.build &&
      packageFiles.some(isBuildRelevant)
    ) {
      addLane({
        key: `${packageInfo.name}:build`,
        label: `${packageInfo.name}:build`,
        command: [...pnpmCommand, "--filter", packageInfo.name, "build"],
        inputFiles: packageFiles
      });
    }
  }

  if (pushReady && classification.runPack) {
    addLane({
      key: "pack:npm",
      label: "npm package pack",
      command: [...pnpmCommand, "run", "release:pack:check"],
      inputFiles: changedFiles
    });
  }

  return Array.from(lanesByKey.values());
}

function readLatestSummary() {
  if (!existsSync(latestSummaryPath)) {
    return null;
  }
  return JSON.parse(readFileSync(latestSummaryPath, "utf8"));
}

export async function runLanes(inputLanes, runDirectory) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, inputLanes.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputLanes.length) {
        const laneIndex = nextIndex++;
        const lane = inputLanes[laneIndex];
        results.push(await runLane(lane, laneIndex, runDirectory));
      }
    })
  );

  return results.sort((left, right) => left.index - right.index);
}

function runLane(lane, index, runDirectory) {
  const logPath = join(runDirectory, `${sanitizeFileName(lane.key)}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });
  const startedAt = Date.now();

  if (verbose) {
    console.log(`[${lane.label}] started`);
  }

  return new Promise((resolve) => {
    const [command, ...args] = lane.command;
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    logStream.write(`$ ${formatCommand(lane.command)}\n\n`);
    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));

    child.on("error", (error) => {
      logStream.write(`\n[runner] ${error.message}\n`);
      logStream.end();
      resolve(buildLaneResult(lane, index, logPath, startedAt, 1));
    });

    child.on("close", (code) => {
      logStream.end();
      const exitCode = typeof code === "number" ? code : 1;
      const result = buildLaneResult(lane, index, logPath, startedAt, exitCode);
      if (verbose) {
        console.log(
          `[${lane.label}] ${exitCode === 0 ? "passed" : "failed"} ${formatDuration(result.durationMs)}`
        );
      }
      resolve(result);
    });
  });
}

function buildLaneResult(lane, index, logPath, startedAt, exitCode) {
  return {
    command: lane.command,
    durationMs: Date.now() - startedAt,
    exitCode,
    index,
    inputFiles: lane.inputFiles,
    inputFingerprint: lane.inputFingerprint,
    key: lane.key,
    label: lane.label,
    logPath,
    logPathRelative: relative(workspaceRoot, logPath),
    reused: false
  };
}

function printPlan(inputLanes, reusedResults = []) {
  const reusedSuffix =
    reusedResults.length > 0 ? `, ${reusedResults.length} reused` : "";
  console.log(
    `check:changed plan (${inputLanes.length} to run${reusedSuffix})`
  );
  for (const lane of inputLanes) {
    console.log(`- ${lane.label}: ${formatCommand(lane.command)}`);
  }
  for (const result of reusedResults) {
    console.log(`- ${result.label}: reuse passed result`);
  }
}

export function printSummary(results, failures, durationMs, runDirectory) {
  const reusedCount = results.filter((result) => result.reused).length;
  const runCount = results.length - reusedCount;
  const reuseSuffix =
    reusedCount > 0 ? ` (${runCount} run, ${reusedCount} reused)` : "";
  if (failures.length === 0) {
    console.log(
      `check:changed passed ${results.length} lane(s) in ${formatDuration(durationMs)}${reuseSuffix}`
    );
    return;
  }

  console.error(
    `check:changed failed ${failures.length}/${results.length} lane(s) in ${formatDuration(durationMs)}${reuseSuffix}`
  );
  for (const failure of failures) {
    const output = failureExcerpt(failure.logPath, tailLines);
    const header = output.truncated
      ? `${failure.label} ${output.label} (full log: ${failure.logPathRelative})`
      : `${failure.label} ${output.label}`;
    console.error(`\n--- ${header} ---`);
    console.error(output.text);
  }
  console.error(
    `\nfull logs: ${relative(workspaceRoot, runDirectory)}\nRerun failed lanes with: pnpm check:changed -- --failed-only`
  );
}

function listChangedFiles(ref) {
  const files = new Set();
  for (const args of [
    ["diff", "--name-only", `${ref}...HEAD`],
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ]) {
    for (const file of gitLines(args)) {
      files.add(file);
    }
  }
  return Array.from(files).sort();
}

function loadPackageInfos() {
  return gitLines([
    "ls-files",
    "apps/*/package.json",
    "packages/*/*/package.json",
    "services/tuttid/builtin-apps/*/package.json",
    "tools/fixtures/*/package.json"
  ])
    .map((packageJsonPath) => {
      const packageJson = JSON.parse(
        readFileSync(join(workspaceRoot, packageJsonPath), "utf8")
      );
      return {
        name: packageJson.name,
        root: dirname(packageJsonPath).replaceAll("\\", "/"),
        scripts: packageJson.scripts ?? {}
      };
    })
    .filter((packageInfo) => packageInfo.name)
    .sort((left, right) => right.root.length - left.root.length);
}

function gitLines(args) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveDefaultBaseRef() {
  for (const candidate of ["origin/main", "main"]) {
    const result = spawnSync("git", ["rev-parse", "--verify", candidate], {
      cwd: workspaceRoot,
      encoding: "utf8"
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "HEAD";
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

export function parseCliArgs(inputArgs) {
  const options = {
    baseRef: null,
    dryRun: false,
    failedOnly: false,
    maxParallel: 4,
    pushReady: false,
    tailLines: 80,
    verbose: false
  };
  const args = inputArgs.filter((arg) => arg !== "--");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--failed-only":
        options.failedOnly = true;
        break;
      case "--push-ready":
        options.pushReady = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--base":
        options.baseRef = readCliValue(args, ++index, arg);
        break;
      case "--max-parallel":
        options.maxParallel = readPositiveIntegerCliValue(args, ++index, arg);
        break;
      case "--tail-lines":
        options.tailLines = readPositiveIntegerCliValue(args, ++index, arg);
        break;
      default:
        throw new UserFacingError(`unknown option: ${arg}`);
    }
  }

  return options;
}

function readCliValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new UserFacingError(`${option} requires a value`);
  }
  return value;
}

function readPositiveIntegerCliValue(args, index, option) {
  const value = readCliValue(args, index, option);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new UserFacingError(`${option} requires a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function applyCliOptions(options) {
  maxParallel = options.maxParallel;
  tailLines = options.tailLines;
  dryRun = options.dryRun;
  failedOnly = options.failedOnly;
  pushReady = options.pushReady;
  verbose = options.verbose;
  baseRef = options.baseRef ?? resolveDefaultBaseRef();
}

function isLintableCodeFile(file) {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file);
}

export function selectExistingLintFiles(
  changedFiles,
  fileExists = fileExistsWithinWorkspace
) {
  return changedFiles.filter(
    (file) => isLintableCodeFile(file) && fileExists(file)
  );
}

function isTestFile(file) {
  return /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file);
}

function isPackageValidationRelevant(file) {
  return (
    isLintableCodeFile(file) ||
    isTestFile(file) ||
    /(?:^|\/)(package\.json|tsconfig[^/]*\.json|vitest\.config\.ts|tsup\.config\.ts)$/u.test(
      file
    )
  );
}

function isBuildRelevant(file) {
  return (
    isPackageValidationRelevant(file) ||
    /(?:^|\/)(assets|public|style|styles)\//u.test(file) ||
    /(?:electron\.vite\.config\.ts|vite\.web\.config\.mjs)$/u.test(file)
  );
}

function isGlobalTypecheckRelevant(file) {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json"
  ].includes(file);
}

function isTypeScriptValidationInput(file) {
  return (
    isPackageValidationRelevant(file) ||
    ["pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) ||
    file.startsWith("packages/configs/")
  );
}

function isGoValidationInput(file) {
  return (
    file.endsWith(".go") ||
    /(?:^|\/)go\.(?:mod|sum)$/u.test(file) ||
    ["go.work", "go.work.sum"].includes(file) ||
    file.startsWith("services/tuttid/.golangci")
  );
}

function selectGoLaneInputs(changedFiles, moduleRoot, forceBuiltinGenerate) {
  return changedFiles.filter(
    (file) =>
      (isGoValidationInput(file) && resolveGoModuleRoot(file) === moduleRoot) ||
      (forceBuiltinGenerate &&
        moduleRoot === "services/tuttid" &&
        file.startsWith("services/tuttid/builtin-apps/tutti-onboarding/"))
  );
}

function fileExistsWithinWorkspace(file) {
  return existsSync(join(workspaceRoot, file));
}

function formatCommand(command) {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function failureExcerpt(path, lineCount) {
  if (!existsSync(path)) {
    return { label: "full log", text: "", truncated: false };
  }

  const excerpt = formatFailureExcerpt(readFileSync(path, "utf8"), lineCount);
  return {
    ...excerpt,
    label: excerpt.truncated
      ? `failure excerpt last ${lineCount} lines`
      : "failure output"
  };
}

class UserFacingError extends Error {}

const currentPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentPath) {
  Promise.resolve()
    .then(() => applyCliOptions(parseCliArgs(process.argv.slice(2))))
    .then(() => main())
    .catch((error) => {
      console.error(
        error instanceof UserFacingError || error instanceof LaneCacheError
          ? `check:changed: ${error.message}`
          : error instanceof Error
            ? (error.stack ?? error.message)
            : error
      );
      process.exitCode = 1;
    });
}
