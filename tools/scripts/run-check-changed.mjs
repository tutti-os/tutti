import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGoLintLane,
  buildGoTestLane,
  buildPackageTestCommand,
  isBuiltinGenerateRequired,
  resolveGoValidationTargets
} from "./run-check-changed-targets.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const maxParallel = Number.parseInt(readOption("--max-parallel") ?? "4", 10);
const tailLines = readPositiveIntegerOption("--tail-lines", 80);
const dryRun = process.argv.includes("--dry-run");
const failedOnly = process.argv.includes("--failed-only");
const pushReady = process.argv.includes("--push-ready");
const verbose = process.argv.includes("--verbose");
const baseRef = readOption("--base") ?? resolveDefaultBaseRef();
const tmpRoot = join(workspaceRoot, ".tmp", "check-runs");
const latestSummaryPath = join(tmpRoot, "latest.json");

const packageInfos = loadPackageInfos();
const lanes = failedOnly ? readFailedLanes() : buildChangedLanes();

if (lanes.length === 0) {
  console.log(
    failedOnly
      ? "check:changed found no failed lanes in the latest run"
      : "check:changed found no changed files to validate"
  );
  process.exit(0);
}

if (dryRun) {
  printPlan(lanes);
  process.exit(0);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDirectory = join(tmpRoot, runId);
mkdirSync(runDirectory, { recursive: true });

if (verbose) {
  console.log(`check:changed running ${lanes.length} lane(s)`);
  console.log(`logs: ${relative(workspaceRoot, runDirectory)}`);
}

const startedAt = Date.now();
const results = await runLanes(lanes, runDirectory);
const durationMs = Date.now() - startedAt;
const summary = {
  baseRef,
  durationMs,
  failedOnly,
  pushReady,
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
printSummary(results, failures, durationMs);

if (failures.length > 0) {
  process.exitCode = 1;
}

function buildChangedLanes() {
  const changedFiles = listChangedFiles(baseRef);
  const lanesByKey = new Map();
  const addLane = (lane) => {
    if (!lanesByKey.has(lane.key)) {
      lanesByKey.set(lane.key, lane);
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
    ]
  });

  const lintFiles = changedFiles.filter(isLintableCodeFile);
  if (lintFiles.length > 0) {
    addLane({
      key: "lint:changed",
      label: "lint:changed",
      command: [pnpmCommand, "exec", "oxlint", "--deny-warnings", ...lintFiles]
    });
  }

  if (changedFiles.some(isElectronRuntimeBoundaryRelevant)) {
    addLane({
      key: "boundary:electron",
      label: "boundary:electron",
      command: [pnpmCommand, "run", "check:electron-runtime-boundaries"]
    });
  }

  if (changedFiles.some(isUiBoundaryRelevant)) {
    addLane({
      key: "boundary:ui",
      label: "boundary:ui",
      command: [pnpmCommand, "run", "check:ui-boundaries"]
    });
  }

  if (
    changedFiles.some((file) =>
      file.startsWith("apps/desktop/src/renderer/src/")
    )
  ) {
    addLane({
      key: "boundary:renderer",
      label: "boundary:renderer",
      command: [pnpmCommand, "run", "check:renderer-boundaries"]
    });
  }

  const goValidationTargets = resolveGoValidationTargets(changedFiles);
  const forceBuiltinGenerate = isBuiltinGenerateRequired(changedFiles);
  if (goValidationTargets) {
    for (const [moduleRoot, targets] of goValidationTargets.lintByModule) {
      addLane(
        buildGoLintLane({
          moduleRoot,
          targets,
          shellQuote,
          workspaceRoot
        })
      );
    }
    for (const [moduleRoot, targets] of goValidationTargets.testByModule) {
      addLane(
        buildGoTestLane({
          forceBuiltinGenerate,
          moduleRoot,
          pnpmCommand,
          shellQuote,
          targets
        })
      );
    }

    if (pushReady) {
      addLane({
        key: "build:go",
        label: "build:go",
        command: [pnpmCommand, "run", "build:go"]
      });
    }
  }

  const rootGlobalChange = changedFiles.some(isGlobalTypecheckRelevant);
  if (rootGlobalChange) {
    addLane({
      key: "typecheck:all",
      label: "typecheck:all",
      command: [process.execPath, "./tools/scripts/run-typecheck.mjs"]
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
        ]
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
          command
        });
      }
    }

    if (
      pushReady &&
      packageInfo.scripts.build &&
      packageFiles.some(isBuildRelevant)
    ) {
      addLane({
        key: `${packageInfo.name}:build`,
        label: `${packageInfo.name}:build`,
        command: [pnpmCommand, "--filter", packageInfo.name, "build"]
      });
    }
  }

  if (changedFiles.some((file) => file.startsWith("tools/scripts/"))) {
    addLane({
      key: "test:tools",
      label: "test:tools",
      command: [pnpmCommand, "run", "test:tools"]
    });
  }

  return Array.from(lanesByKey.values());
}

function readFailedLanes() {
  if (!existsSync(latestSummaryPath)) {
    return [];
  }
  const summary = JSON.parse(readFileSync(latestSummaryPath, "utf8"));
  return (summary.results ?? [])
    .filter((result) => result.exitCode !== 0)
    .map((result) => ({
      key: result.key,
      label: result.label,
      command: result.command
    }));
}

async function runLanes(inputLanes, runDirectory) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, inputLanes.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputLanes.length) {
        const lane = inputLanes[nextIndex++];
        results.push(await runLane(lane, runDirectory));
      }
    })
  );

  return results.sort((left, right) => left.index - right.index);
}

function runLane(lane, runDirectory) {
  const index = lanes.indexOf(lane);
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
    key: lane.key,
    label: lane.label,
    logPath,
    logPathRelative: relative(workspaceRoot, logPath)
  };
}

function printPlan(inputLanes) {
  console.log(`check:changed plan (${inputLanes.length} lane(s))`);
  for (const lane of inputLanes) {
    console.log(`- ${lane.label}: ${formatCommand(lane.command)}`);
  }
}

function printSummary(results, failures, durationMs) {
  if (failures.length === 0) {
    console.log(
      `check:changed passed ${results.length} lane(s) in ${formatDuration(durationMs)}`
    );
    return;
  }

  console.error(
    `check:changed failed ${failures.length}/${results.length} lane(s) in ${formatDuration(durationMs)}`
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

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function readPositiveIntegerOption(name, defaultValue) {
  const value = readOption(name);
  if (value === null) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function isLintableCodeFile(file) {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file);
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

function isElectronRuntimeBoundaryRelevant(file) {
  return (
    file === "apps/desktop/electron.vite.config.ts" ||
    file.startsWith("apps/desktop/src/main/") ||
    file.startsWith("apps/desktop/src/preload/") ||
    file.startsWith("apps/desktop/src/shared/") ||
    file.startsWith("packages/")
  );
}

function isUiBoundaryRelevant(file) {
  return (
    (file.startsWith("apps/") ||
      file.startsWith("packages/") ||
      file.startsWith("tools/")) &&
    /\.(?:css|json|js|jsx|mjs|ts|tsx)$/u.test(file)
  );
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

  const content = readFileSync(path, "utf8");
  const lines = splitLines(content);
  const failureMarkerIndex = lines.findIndex((line) =>
    line.includes("✖ failing tests:")
  );
  if (failureMarkerIndex !== -1) {
    const excerpt = stripPnpmFailureBoilerplate(
      lines.slice(failureMarkerIndex)
    );
    const truncated = excerpt.length > lineCount;
    return {
      label: truncated
        ? `failure excerpt last ${lineCount} lines`
        : "failure excerpt",
      text: excerpt.slice(-lineCount).join("\n"),
      truncated
    };
  }

  const commandlessLines =
    lines[0]?.startsWith("$ ") && lines[1] === "" ? lines.slice(2) : lines;
  const truncated = commandlessLines.length > lineCount;
  return {
    label: truncated ? `tail last ${lineCount} lines` : "full log",
    text: commandlessLines.slice(-lineCount).join("\n"),
    truncated
  };
}

function splitLines(content) {
  if (content.length === 0) {
    return [];
  }
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
}

function stripPnpmFailureBoilerplate(lines) {
  return lines.filter(
    (line) =>
      !line.includes("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL") &&
      !line.startsWith("Exit status ") &&
      !/^\/.*:$/.test(line)
  );
}
