import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import readline from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFailureExcerpt,
  formatSlowestLanes
} from "./run-validation-lanes.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const pnpmCommand = resolvePnpmCommand();
const verbose = process.argv.includes("--verbose");
const failureLinesPerTask = readPositiveIntegerOption("--tail-lines", 120);
const tmpRoot = join(workspaceRoot, ".tmp", "check-full-runs");

const phases = [
  {
    title: "Preparation",
    tasks: [{ label: "builtin-apps", script: "generate:builtin-apps" }]
  },
  {
    title: "Preflight checks",
    tasks: [
      { label: "defaults", script: "check:defaults-generated" },
      {
        label: "agent-gui-provider-catalog",
        script: "check:agent-gui-provider-catalog-generated"
      },
      { label: "api", script: "check:api-generated" },
      { label: "event-protocol", script: "check:event-protocol-generated" },
      { label: "codexproto", script: "check:codexproto-generated" },
      { label: "tutti-names", script: "check:tutti-names" },
      { label: "i18n", script: "check:i18n" },
      {
        label: "electron-runtime-boundaries",
        script: "check:electron-runtime-boundaries"
      },
      { label: "ui-boundaries", script: "check:ui-boundaries" },
      { label: "renderer-boundaries", script: "check:renderer-boundaries" },
      {
        label: "agent-activity-runtime-boundaries",
        script: "check:agent-activity-runtime-boundaries"
      },
      {
        label: "agent-gui-degradation",
        script: "check:agent-gui-degradation"
      }
    ]
  },
  {
    title: "Validation checks",
    tasks: [
      { label: "lint:ts", script: "lint:ts" },
      { label: "lint:go", script: "lint:go:prepared" },
      { label: "typecheck", script: "typecheck" },
      { label: "test:ts", script: "test:ts" },
      { label: "test:go", script: "test:go:prepared" }
    ]
  }
];

export async function main() {
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const runDirectory = join(tmpRoot, runId);
  mkdirSync(runDirectory, { recursive: true });

  const startedAt = Date.now();
  const results = [];
  let failed = false;

  for (const phase of phases) {
    console.log(`\n==> ${phase.title}`);
    const phaseStartedAt = Date.now();
    const phaseResults = await Promise.all(
      phase.tasks.map((task) => runTask(task, phase.title, runDirectory))
    );
    results.push(...phaseResults);
    const phaseDurationMs = Date.now() - phaseStartedAt;
    const failures = phaseResults.filter((result) => result.exitCode !== 0);

    if (failures.length > 0) {
      console.error(
        `${phase.title} failed ${failures.length}/${phase.tasks.length} task(s) in ${formatDuration(phaseDurationMs)}`
      );
      printFailureSummary(failures, runDirectory);
      failed = true;
      break;
    }

    console.log(
      `${phase.title} passed ${phase.tasks.length} task(s) in ${formatDuration(phaseDurationMs)}`
    );
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    durationMs,
    failureLinesPerTask,
    runDirectory,
    startedAt: new Date(startedAt).toISOString(),
    verbose,
    results
  };
  writeFileSync(
    join(runDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(
    join(tmpRoot, "latest.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `\ncheck:full passed ${results.length} task(s) in ${formatDuration(durationMs)}`
  );
  const slowest = formatSlowestLanes(results);
  console.log(
    `slowest tasks: ${slowest} (details: ${relative(workspaceRoot, join(tmpRoot, "latest.json"))})`
  );
}

function runTask(task, phase, runDirectory) {
  const logPath = join(runDirectory, `${sanitizeFileName(task.label)}.log`);
  const logPathRelative = relative(workspaceRoot, logPath);
  const logStream = createWriteStream(logPath, { flags: "w" });
  const startedAt = Date.now();
  const [command, ...prefixArgs] = pnpmCommand;
  const args = [...prefixArgs, "run", task.script];

  if (verbose) {
    console.log(`[${task.label}] starting`);
  }
  logStream.write(`$ ${formatCommand([command, ...args])}\n\n`);

  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));
    if (verbose) {
      pipeWithPrefix(child.stdout, task.label, process.stdout);
      pipeWithPrefix(child.stderr, task.label, process.stderr);
    }

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      logStream.write(`\n[runner] ${error.message}\n`);
      finish(1);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      finish(typeof code === "number" ? code : 1);
    });

    function finish(exitCode) {
      const result = {
        durationMs: Date.now() - startedAt,
        exitCode,
        label: task.label,
        logPath,
        logPathRelative,
        phase,
        script: task.script
      };
      logStream.end(() => {
        if (verbose) {
          console.log(
            `[${task.label}] ${exitCode === 0 ? "passed" : "failed"} ${formatDuration(result.durationMs)}`
          );
        } else if (exitCode !== 0) {
          printTaskFailure(result);
        }
        resolveResult(result);
      });
    }
  });
}

function printFailureSummary(failures, runDirectory) {
  console.error(
    `failed tasks: ${failures.map((failure) => failure.label).join(", ")}`
  );
  console.error(
    `\nfull logs: ${relative(workspaceRoot, runDirectory)}\nRerun with live output: pnpm check:full -- --verbose`
  );
}

function printTaskFailure(failure) {
  const excerpt = formatFailureExcerpt(
    readFileSync(failure.logPath, "utf8"),
    failureLinesPerTask
  );
  const label = excerpt.truncated
    ? `failure excerpt last ${failureLinesPerTask} lines`
    : "failure output";
  console.error(
    `\n[${failure.label}] failed in ${formatDuration(failure.durationMs)}`
  );
  console.error(`--- ${label} (full log: ${failure.logPathRelative}) ---`);
  console.error(excerpt.text);
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

function readPositiveIntegerOption(name, defaultValue) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return defaultValue;
  }
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
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

function pipeWithPrefix(stream, label, output) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => output.write(`[${label}] ${line}\n`));
}

function isMainModule() {
  return (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error
    );
    process.exitCode = 1;
  });
}
