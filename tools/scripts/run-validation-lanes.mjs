import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

export async function runValidationLanes({
  lanes,
  maxParallel,
  summaryLabel,
  tailLines,
  tmpDirectoryName,
  workspaceRoot
}) {
  if (lanes.length === 0) {
    console.log(`${summaryLabel} found no lanes to validate`);
    return { exitCode: 0, results: [] };
  }

  const tmpRoot = join(workspaceRoot, ".tmp", tmpDirectoryName);
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const runDirectory = join(tmpRoot, runId);
  mkdirSync(runDirectory, { recursive: true });

  const startedAt = Date.now();
  const results = await runLanes({
    lanes,
    maxParallel,
    runDirectory,
    tailLines,
    workspaceRoot
  });
  const durationMs = Date.now() - startedAt;
  const failures = results.filter((result) => result.exitCode !== 0);
  const summary = {
    durationMs,
    laneCount: lanes.length,
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
  writeFileSync(
    join(tmpRoot, "latest.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );

  if (failures.length === 0) {
    console.log(
      `${summaryLabel} passed ${lanes.length} lane(s) in ${formatDuration(durationMs)}`
    );
    printLaneTimingSummary(results, workspaceRoot, tmpRoot);
    return { exitCode: 0, results };
  }

  console.error(
    `${summaryLabel} failed ${failures.length}/${lanes.length} lane(s) in ${formatDuration(durationMs)}`
  );
  printLaneTimingSummary(results, workspaceRoot, tmpRoot, console.error);
  console.error(
    `failed lanes: ${failures.map((failure) => failure.label).join(", ")}`
  );

  console.error(`\nfull logs: ${relative(workspaceRoot, runDirectory)}`);

  return { exitCode: 1, results };
}

async function runLanes({
  lanes,
  maxParallel,
  runDirectory,
  tailLines,
  workspaceRoot
}) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, lanes.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < lanes.length) {
        const index = nextIndex++;
        results.push(
          await runLane({
            index,
            lane: lanes[index],
            runDirectory,
            tailLines,
            workspaceRoot
          })
        );
      }
    })
  );

  return results.sort((left, right) => left.index - right.index);
}

function runLane({ index, lane, runDirectory, tailLines, workspaceRoot }) {
  const logPath = join(runDirectory, `${sanitizeFileName(lane.key)}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(lane.command[0], lane.command.slice(1), {
      cwd: lane.cwd ?? workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    logStream.write(`$ ${formatCommand(lane.command)}\n\n`);
    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));

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
      logStream.end(() => {
        const result = {
          durationMs: Date.now() - startedAt,
          exitCode,
          index,
          key: lane.key,
          label: lane.label,
          logPath,
          logPathRelative: relative(workspaceRoot, logPath)
        };
        if (exitCode !== 0) {
          printFailure(result, tailLines);
        }
        resolve(result);
      });
    }
  });
}

export function readPositiveIntegerOption(name, defaultValue) {
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

export function formatSlowestLanes(results, limit = 3) {
  return [...results]
    .filter((result) => Number.isFinite(result.durationMs))
    .sort(
      (left, right) =>
        right.durationMs - left.durationMs ||
        left.label.localeCompare(right.label)
    )
    .slice(0, Math.max(0, limit))
    .map((result) => `${result.label} ${formatDuration(result.durationMs)}`)
    .join(", ");
}

function printLaneTimingSummary(
  results,
  workspaceRoot,
  tmpRoot,
  write = console.log
) {
  const slowest = formatSlowestLanes(results);
  if (slowest === "") {
    return;
  }
  const latestPath = relative(workspaceRoot, join(tmpRoot, "latest.json"));
  write(`slowest lanes: ${slowest} (details: ${latestPath})`);
}

function printFailure(failure, lineCount) {
  const excerpt = failureExcerptFromFile(failure.logPath, lineCount);
  const header = excerpt.truncated
    ? `${failure.label} failure excerpt last ${lineCount} lines (full log: ${failure.logPathRelative})`
    : `${failure.label} failure output`;
  console.error(`\n--- ${header} ---`);
  console.error(excerpt.text);
}

function failureExcerptFromFile(path, lineCount) {
  if (!existsSync(path)) {
    return { text: "", truncated: false };
  }
  return formatFailureExcerpt(readFileSync(path, "utf8"), lineCount);
}

export function formatFailureExcerpt(content, lineCount) {
  const lines = splitLines(content).map((line) =>
    stripVTControlCharacters(line)
  );
  const failureMarkerIndex = lines.findIndex((line) =>
    line.includes("✖ failing tests:")
  );
  const relevantLines =
    failureMarkerIndex === -1
      ? lines[0]?.startsWith("$ ") && lines[1] === ""
        ? lines.slice(2)
        : lines
      : lines.slice(failureMarkerIndex);
  const filteredLines = collapseRepeatedLines(
    relevantLines.filter((line) => !isFailureBoilerplate(line))
  );
  const limit = Math.max(
    0,
    Number.isFinite(lineCount) ? Math.floor(lineCount) : 0
  );
  return {
    text: limit === 0 ? "" : filteredLines.slice(-limit).join("\n"),
    truncated: filteredLines.length > limit
  };
}

function isFailureBoilerplate(line) {
  return (
    line.includes("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL") ||
    line.startsWith("Exit status ") ||
    /^\s*ELIFECYCLE\s+Command failed/u.test(line) ||
    /^>\s+\S+@\S+\s+\S+\s+(?:\/|[A-Za-z]:\\)/u.test(line) ||
    /^>\s+(?:go|jest|node|npm|pnpm|tsx|vitest|yarn)\b/u.test(line)
  );
}

function collapseRepeatedLines(lines) {
  const collapsed = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && lines[nextIndex] === line) {
      nextIndex += 1;
    }
    const count = nextIndex - index;
    collapsed.push(
      count > 1 && line !== "" ? `${line} (repeated ${count} times)` : line
    );
    index = nextIndex;
  }
  return collapsed;
}

function splitLines(content) {
  if (content.length === 0) {
    return [];
  }
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
}
