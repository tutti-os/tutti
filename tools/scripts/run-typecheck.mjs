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

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const nodeCommand = process.execPath;
const maxParallel = readPositiveIntegerOption("--max-parallel", 4);
const tailLines = readPositiveIntegerOption("--tail-lines", 80);
const tmpRoot = join(workspaceRoot, ".tmp", "typecheck-runs");
const latestSummaryPath = join(tmpRoot, "latest.json");

const packages = loadTypecheckPackages();

if (packages.length === 0) {
  console.log("typecheck found no packages to validate");
  process.exit(0);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDirectory = join(tmpRoot, runId);
mkdirSync(runDirectory, { recursive: true });

const startedAt = Date.now();
const results = await runPackages(packages, runDirectory);
const durationMs = Date.now() - startedAt;
const failures = results.filter((result) => result.exitCode !== 0);
const summary = {
  durationMs,
  packageCount: packages.length,
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

if (failures.length === 0) {
  console.log(
    `typecheck passed ${packages.length} package(s) in ${formatDuration(durationMs)}`
  );
  process.exit(0);
}

console.error(
  `typecheck failed ${failures.length}/${packages.length} package(s) in ${formatDuration(durationMs)}`
);

console.error(
  `failed packages: ${failures.map((failure) => failure.name).join(", ")}`
);

const diagnostics = collectDiagnostics(failures);
if (diagnostics.length > 0) {
  console.error("\n--- diagnostics ---");
  console.error(diagnostics.slice(-tailLines).join("\n"));
  if (diagnostics.length > tailLines) {
    console.error(`\n(showing last ${tailLines}/${diagnostics.length} lines)`);
  }
} else {
  for (const failure of failures) {
    const tail = tailFile(failure.logPath, tailLines);
    const header = tail.truncated
      ? `${failure.name} tail last ${tailLines} lines (full log: ${failure.logPathRelative})`
      : `${failure.name} full log`;
    console.error(`\n--- ${header} ---`);
    console.error(tail.text);
  }
}
console.error(`\nfull logs: ${relative(workspaceRoot, runDirectory)}`);

process.exit(1);

function loadTypecheckPackages() {
  return gitLines([
    "ls-files",
    "apps/*/package.json",
    "packages/*/*/package.json",
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
    .filter((packageInfo) => packageInfo.name && packageInfo.scripts.typecheck)
    .sort((left, right) => left.root.localeCompare(right.root));
}

async function runPackages(inputPackages, runDirectory) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, inputPackages.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputPackages.length) {
        const packageInfo = inputPackages[nextIndex++];
        results.push(await runPackage(packageInfo, runDirectory));
      }
    })
  );

  return results.sort((left, right) => left.index - right.index);
}

function runPackage(packageInfo, runDirectory) {
  const index = packages.indexOf(packageInfo);
  const logPath = join(
    runDirectory,
    `${sanitizeFileName(packageInfo.root)}.log`
  );
  const logStream = createWriteStream(logPath, { flags: "w" });
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const args = [
      join(workspaceRoot, "tools", "scripts", "run-tsgo-typecheck.mjs"),
      "--package-root",
      packageInfo.root
    ];
    const child = spawn(nodeCommand, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    logStream.write(`$ ${formatCommand([nodeCommand, ...args])}\n\n`);
    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));

    child.on("error", (error) => {
      logStream.write(`\n[runner] ${error.message}\n`);
      logStream.end();
      resolve(buildPackageResult(packageInfo, index, logPath, startedAt, 1));
    });

    child.on("close", (code) => {
      logStream.end();
      const exitCode = typeof code === "number" ? code : 1;
      resolve(
        buildPackageResult(packageInfo, index, logPath, startedAt, exitCode)
      );
    });
  });
}

function buildPackageResult(packageInfo, index, logPath, startedAt, exitCode) {
  return {
    durationMs: Date.now() - startedAt,
    exitCode,
    index,
    name: packageInfo.name,
    root: packageInfo.root,
    logPath,
    logPathRelative: relative(workspaceRoot, logPath)
  };
}

function collectDiagnostics(failures) {
  const diagnostics = [];
  const seen = new Set();

  for (const failure of failures) {
    if (!existsSync(failure.logPath)) {
      continue;
    }
    const content = readFileSync(failure.logPath, "utf8");
    for (const line of content.split("\n")) {
      const diagnostic = normalizeDiagnosticLine(line, failure.root);
      if (!diagnostic || seen.has(diagnostic)) {
        continue;
      }
      seen.add(diagnostic);
      diagnostics.push(diagnostic);
    }
  }

  return diagnostics;
}

function normalizeDiagnosticLine(line, packageRoot) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("$ ")) {
    return null;
  }

  const match =
    /^(?<file>.+?\.(?:cts|mts|ts|tsx))(?<suffix>\(\d+,\d+\): error TS\d+: .*)$/u.exec(
      trimmed
    );
  if (!match?.groups) {
    return trimmed;
  }

  const absolutePath = join(workspaceRoot, packageRoot, match.groups.file);
  return `${relative(workspaceRoot, absolutePath).replaceAll("\\", "/")}${match.groups.suffix}`;
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

function tailFile(path, lineCount) {
  if (!existsSync(path)) {
    return { text: "", truncated: false };
  }
  const content = readFileSync(path, "utf8");
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const truncated = lines.length > lineCount;
  return {
    text: lines.slice(-lineCount).join("\n"),
    truncated
  };
}
