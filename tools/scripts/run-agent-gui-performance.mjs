#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  defaultTraceCategories,
  resolveBrowserWebSocketUrl,
  resolvePageWebSocketUrl,
  writeStreamToFile
} from "./capture-electron-trace.mjs";
import {
  analyzeElectronTrace,
  renderElectronTraceMarkdown
} from "./analyze-electron-trace.mjs";
import {
  agentGuiPerformanceScenarios,
  resolveAgentGuiPerformanceScenario
} from "./agent-gui-performance-scenarios.mjs";
import { startAllProcessTimeProfile } from "./all-process-time-profile.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..", "..");
const desktopReadyTimeoutMs = 120_000;
const scenarioReadyTimeoutMs = 60_000;
const recoverableQueueTables = [
  "workspace_agent_runtime_operation_events",
  "workspace_agent_runtime_operations",
  "workspace_agent_goal_reconcile_inbox",
  "workspace_agent_goal_control_operations",
  "workspace_agent_submit_claims"
];

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[perf:agent-gui] ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  if (options.listScenarios) {
    process.stdout.write(
      `${agentGuiPerformanceScenarios.map((scenario) => scenario.id).join("\n")}\n`
    );
    return;
  }
  const scenario = resolveAgentGuiPerformanceScenario(options.scenario);
  const outputDirectory = resolve(
    options.outputDirectory ?? defaultOutputDirectory(scenario.id, new Date())
  );
  const runtimeParent = join(workspaceRoot, ".tmp");
  await mkdir(runtimeParent, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const runtimeDirectory = await mkdtemp(
    join(runtimeParent, "agent-gui-perf-runtime-")
  );
  const stateDirectory = join(runtimeDirectory, "state");
  const userDataDirectory = join(runtimeDirectory, "electron-user-data");
  const databasePath = join(stateDirectory, "tuttid.db");
  const daemonPath = join(runtimeDirectory, "tuttid");
  const tracePath = join(outputDirectory, "trace.json");
  const reportJSONPath = join(outputDirectory, "report.json");
  const reportMarkdownPath = join(outputDirectory, "report.md");
  const desktopLogPath = join(outputDirectory, "desktop.log");
  const timeProfilePath = join(outputDirectory, "time-profile.trace");
  let desktopProcess = null;
  let pageClient = null;
  let browserClient = null;
  let timeProfileCapture = null;
  let primaryError = null;

  log(`source snapshot: ${basename(options.sourceDatabase)}`);
  log(`output: ${outputDirectory}`);
  try {
    await access(options.sourceDatabase);
    await mkdir(stateDirectory, { recursive: true });
    await snapshotSQLiteDatabase(options.sourceDatabase, databasePath);
    const snapshotInfo = await prepareDatabaseSnapshot(databasePath);
    const scenarioSnapshot = scenario.prepareSnapshot
      ? await scenario.prepareSnapshot({
          databasePath,
          runtimeDirectory,
          sqliteExec,
          sqliteJSON,
          workspaceRoot
        })
      : null;
    log(
      `snapshot ready: ${snapshotInfo.sessionCount} sessions, ${snapshotInfo.projectCount} projects`
    );

    await buildDaemon(daemonPath);
    const cdpPort = await reservePort();
    desktopProcess = startDesktop({
      cdpPort,
      daemonPath,
      desktopLogPath,
      environment: scenarioSnapshot?.environment,
      stateDirectory,
      userDataDirectory
    });
    const pageWebSocket = await waitForPageWebSocket(
      cdpPort,
      desktopProcess,
      desktopReadyTimeoutMs
    );
    pageClient = await CdpClient.connect(pageWebSocket);
    await pageClient.send("Runtime.enable");
    browserClient = await CdpClient.connect(
      await resolveBrowserWebSocketUrl(cdpPort)
    );
    const context = {
      browserClient,
      pageClient,
      scenarioData: scenarioSnapshot?.data ?? null,
      targetID: targetIDFromWebSocket(pageWebSocket)
    };
    const prepared = await scenario.prepare(context, {
      fromTargetID: options.fromTargetID,
      toTargetID: options.toTargetID,
      timeoutMs: scenarioReadyTimeoutMs
    });
    log(`scenario ${scenario.id}: ${scenario.describe(prepared)}`);

    if (options.allProcessTimeProfile) {
      log("starting all-process Time Profiler");
      timeProfileCapture = await startAllProcessTimeProfile({
        cwd: workspaceRoot,
        outputPath: timeProfilePath,
        timeoutMs: 30_000
      });
    }

    await browserClient.send("Tracing.start", {
      categories: defaultTraceCategories,
      options: "sampling-frequency=10000",
      transferMode: "ReturnAsStream"
    });

    let scenarioResult;
    let scenarioError = null;
    let captureError = null;
    try {
      scenarioResult = await scenario.execute(context, prepared, {
        timeoutMs: scenarioReadyTimeoutMs
      });
    } catch (error) {
      scenarioError = error;
    } finally {
      try {
        await stopTrace(browserClient, tracePath);
      } catch (error) {
        captureError = error;
      }
      if (timeProfileCapture) {
        try {
          await timeProfileCapture.stop();
        } catch (error) {
          captureError ??= error;
        }
      }
    }
    if (scenarioError) throw scenarioError;
    if (captureError) throw captureError;

    const summary = await analyzeElectronTrace({
      tracePath,
      scenario: scenario.id,
      startMarker: scenario.markers.start,
      endMarker: scenario.markers.end,
      milestones: scenario.milestones,
      minimumLongEventMs: options.minimumLongEventMs,
      profileFunctionNames: scenario.profileFunctionNames,
      sourceRoot: workspaceRoot
    });
    summary.run = {
      ...scenario.summarize(prepared, scenarioResult),
      sourceDatabase: basename(options.sourceDatabase),
      sourceSessionCount: snapshotInfo.sessionCount,
      sourceProjectCount: snapshotInfo.projectCount,
      clearedRecoveryRows: snapshotInfo.clearedRecoveryRows
    };
    if (timeProfileCapture) {
      summary.run.details.push({
        label: "All-process Time Profiler",
        value: basename(timeProfilePath)
      });
    }
    applyScenarioAssessment(summary, scenario.assessTrace?.(summary));
    await writeFile(reportJSONPath, `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(
      reportMarkdownPath,
      renderRunMarkdown(
        summary,
        renderElectronTraceMarkdown(summary, { sourceRoot: workspaceRoot })
      )
    );

    log(
      `${summary.mode}: ${summary.renders.componentMarkers} component markers, ${summary.renders.radixFamilyMarkers} Radix-family markers, ${summary.timing.longTaskCount} renderer long tasks`
    );
    log(`report: ${reportMarkdownPath}`);
    log(`trace: ${tracePath}`);
    if (timeProfileCapture) log(`time profile: ${timeProfilePath}`);
    const failureReasons = performanceRunFailureReasons(summary);
    if (failureReasons.length > 0) {
      throw new Error(
        `${scenario.id} performance gate failed: ${failureReasons.join(", ")}`
      );
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    pageClient?.close();
    browserClient?.close();
    if (timeProfileCapture) {
      try {
        await timeProfileCapture.stop();
      } catch (error) {
        if (!primaryError) process.exitCode = 1;
        log(`Time Profiler cleanup warning: ${error.message}`);
      }
    }
    if (desktopProcess) {
      await stopProcessTree(desktopProcess);
    }
    if (!options.keepRuntime) {
      try {
        await rm(runtimeDirectory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200
        });
      } catch (error) {
        if (!primaryError) process.exitCode = 1;
        log(`cleanup warning: ${error.message}`);
      }
    } else {
      log(`runtime kept: ${runtimeDirectory}`);
    }
  }
}

async function snapshotSQLiteDatabase(sourcePath, destinationPath) {
  const escapedDestination = destinationPath.replaceAll("'", "''");
  await runCommand("sqlite3", [
    sourcePath,
    "PRAGMA query_only=ON;",
    ".timeout 10000",
    `.backup '${escapedDestination}'`
  ]);
}

export async function prepareDatabaseSnapshot(databasePath) {
  const counts = await sqliteJSON(
    databasePath,
    `
SELECT
  (SELECT COUNT(*) FROM workspace_agent_sessions) AS sessionCount,
  (SELECT COUNT(*) FROM user_projects) AS projectCount;
`
  );
  const tableRows = await sqliteJSON(
    databasePath,
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;`
  );
  const existingTables = new Set(tableRows.map((row) => row.name));
  if (existingTables.has("agent_store_schema_migrations")) {
    const migrationRows = await sqliteJSON(
      databasePath,
      `SELECT id FROM agent_store_schema_migrations ORDER BY id;`
    );
    const migrationSource = await readFile(
      join(workspaceRoot, "packages", "agent", "store-sqlite", "migrations.go"),
      "utf8"
    );
    const unknownMigrationIDs = findUnknownAgentTargetMigrationIDs(
      migrationRows.map((row) => row.id),
      migrationSource
    );
    if (unknownMigrationIDs.length > 0) {
      throw new Error(
        `source dev DB has newer Agent target migrations (${unknownMigrationIDs.join(", ")}); SQLite migrations are forward-only, so switch to a compatible checkout or pass --source-db for a compatible snapshot`
      );
    }
  }
  const queueCounts = {};
  for (const table of recoverableQueueTables) {
    if (!existingTables.has(table)) continue;
    const rows = await sqliteJSON(
      databasePath,
      `SELECT COUNT(*) AS count FROM ${table};`
    );
    queueCounts[table] = Number(rows[0]?.count ?? 0);
  }

  const startupRows = await sqliteJSON(
    databasePath,
    `
SELECT workspace_id AS workspaceId, snapshot_json AS snapshotJSON
FROM workspace_workbench_snapshots
WHERE workspace_id = (
  SELECT id
  FROM workspaces
  ORDER BY COALESCE(last_opened_at_unix_ms, 0) DESC, updated_at_unix_ms DESC, id ASC
  LIMIT 1
)
LIMIT 1;
`
  );
  const startup = startupRows[0];
  if (!startup?.snapshotJSON) {
    throw new Error("startup workspace has no durable Workbench snapshot");
  }
  const preparedSnapshot = prepareWorkbenchSnapshotForPerformance(
    JSON.parse(startup.snapshotJSON)
  );
  const deleteStatements = recoverableQueueTables
    .filter((table) => existingTables.has(table))
    .map((table) => `DELETE FROM ${table};`)
    .join("\n");
  try {
    await sqliteExec(
      databasePath,
      `
PRAGMA foreign_keys = ON;
${deleteStatements}
UPDATE workspace_workbench_snapshots
SET snapshot_json = '${sqlString(JSON.stringify(preparedSnapshot))}'
WHERE workspace_id = '${sqlString(startup.workspaceId)}';
`
    );
  } catch (error) {
    throw new Error(`failed to sanitize isolated database: ${error.message}`);
  }

  return {
    sessionCount: Number(counts[0]?.sessionCount ?? 0),
    projectCount: Number(counts[0]?.projectCount ?? 0),
    clearedRecoveryRows: Object.values(queueCounts).reduce(
      (total, count) => total + count,
      0
    )
  };
}

export function findUnknownAgentTargetMigrationIDs(
  appliedMigrationIDs,
  migrationSource
) {
  const knownMigrationIDs = new Set(
    [
      ...migrationSource.matchAll(/const schemaMigration\w+\s*=\s*"([^"]+)"/gu)
    ].map((match) => match[1])
  );
  return appliedMigrationIDs
    .filter(
      (migrationID) =>
        migrationID.startsWith("agent_targets_") &&
        !knownMigrationIDs.has(migrationID)
    )
    .sort();
}

export function prepareWorkbenchSnapshotForPerformance(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.nodes)
  ) {
    throw new Error("invalid durable Workbench snapshot");
  }
  const nodes = snapshot.nodes.map((node) => structuredClone(node));
  const candidates = nodes.filter((node) => node?.data?.typeId === "agent-gui");
  const selected =
    candidates.find((node) => node.id === snapshot.activeNodeId) ??
    candidates.find((node) => node.isMinimized !== true) ??
    candidates[0];
  if (!selected) {
    throw new Error("startup Workbench snapshot has no AgentGUI node");
  }
  const existingState =
    selected.data?.snapshotNodeState &&
    typeof selected.data.snapshotNodeState === "object"
      ? selected.data.snapshotNodeState
      : {};
  selected.data = {
    ...selected.data,
    snapshotNodeState: {
      ...existingState,
      conversationRailCollapsed: false,
      lastActiveAgentSessionId: null,
      lastActiveAgentSessionIdByAgentTargetId: {}
    }
  };
  selected.isMinimized = false;
  const nodeStack = Array.isArray(snapshot.nodeStack)
    ? snapshot.nodeStack.filter((nodeID) => nodeID !== selected.id)
    : [];
  nodeStack.push(selected.id);
  return {
    ...snapshot,
    nodes,
    nodeStack,
    activeNodeId: selected.id
  };
}

export function applyScenarioAssessment(summary, assessment) {
  if (!assessment) return summary;
  summary.run.assertions.push(...(assessment.assertions ?? []));
  summary.run.details.push(...(assessment.details ?? []));
  const failedAssertions = summary.run.assertions.filter(
    (assertion) => !assertion.passed
  );
  summary.run.outcome = failedAssertions.length === 0 ? "passed" : "failed";
  summary.mode = "scenario-thresholds";
  summary.verdict =
    failedAssertions.length === 0
      ? {
          status: "passed",
          reason: `${summary.run.assertions.length} scenario assertions passed`
        }
      : {
          status: "failed",
          reason: `${failedAssertions.length} of ${summary.run.assertions.length} scenario assertions failed`
        };
  return summary;
}

export function performanceRunFailureReasons(summary) {
  const failedAssertions = (summary.run?.assertions ?? [])
    .filter((assertion) => !assertion.passed)
    .map((assertion) => assertion.name);
  if (failedAssertions.length > 0) {
    return failedAssertions;
  }
  if (summary.verdict?.status === "failed") {
    return [summary.verdict.reason ?? "trace assessment failed"];
  }
  return [];
}

async function buildDaemon(outputPath) {
  log("building isolated tuttid");
  await runCommand(
    "go",
    ["build", "-buildvcs=false", "-o", outputPath, "."],
    join(workspaceRoot, "services", "tuttid")
  );
}

function startDesktop(input) {
  log(`starting headless isolated Desktop on CDP ${input.cdpPort}`);
  const logStream = createWriteStream(input.desktopLogPath, { flags: "w" });
  const child = spawn("pnpm", ["dev:desktop"], {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...input.environment,
      TUTTI_ANALYTICS_DISABLED: "1",
      TUTTI_DESKTOP_LOG_OUTPUT: "tee",
      TUTTI_DESKTOP_PERFORMANCE_HEADLESS: "1",
      TUTTI_DESKTOP_USER_DATA_DIR: input.userDataDirectory,
      TUTTI_ELECTRON_JS_FLAGS: "--max-old-space-size=8192",
      TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT: String(input.cdpPort),
      TUTTI_ENV: "development",
      TUTTI_STATE_DIR: input.stateDirectory,
      TUTTID_ADDR: "127.0.0.1:0",
      TUTTID_BIN: input.daemonPath,
      TUTTID_LOG_OUTPUT: "tee",
      VITE_TUTTI_REACT_PROFILER: "0",
      VITE_TUTTI_WHY_DID_YOU_RENDER: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const tail = createBoundedLogTail();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      logStream.write(chunk);
      tail.append(chunk.toString());
    });
  }
  child.once("close", () => logStream.end());
  child.performanceLogTail = tail;
  return child;
}

async function waitForPageWebSocket(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Desktop exited before CDP became ready\n${child.performanceLogTail.read()}`
      );
    }
    try {
      return await resolvePageWebSocketUrl(port);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `timed out waiting for Desktop CDP: ${lastError?.message ?? "unknown error"}\n${child.performanceLogTail.read()}`
  );
}

async function stopTrace(client, tracePath) {
  const complete = client.waitForEvent("Tracing.tracingComplete");
  await client.send("Tracing.end");
  const event = await complete;
  const stream = event.params?.stream;
  if (!stream) {
    throw new Error("Tracing.tracingComplete did not include a stream handle");
  }
  await writeStreamToFile(client, stream, tracePath);
}

async function sqliteJSON(databasePath, sql) {
  const output = await runCommand("sqlite3", ["-json", databasePath, sql]);
  return output.trim() ? JSON.parse(output) : [];
}

async function sqliteExec(databasePath, sql) {
  await runCommand("sqlite3", [databasePath, sql]);
}

function runCommand(command, args, cwd = workspaceRoot) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand(stdout);
      } else {
        rejectCommand(
          new Error(
            `${command} failed (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
          )
        );
      }
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("failed to reserve a CDP port");
  return port;
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  } else {
    child.kill("SIGINT");
  }
  await Promise.race([onceExit(child), delay(5_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([onceExit(child), delay(2_000)]);
}

function onceExit(child) {
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

function createBoundedLogTail(limit = 20_000) {
  let value = "";
  return {
    append(chunk) {
      value = (value + chunk).slice(-limit);
    },
    read() {
      return value;
    }
  };
}

function renderRunMarkdown(summary, traceMarkdown) {
  const runLines = [
    "## Scenario contract",
    "",
    `- Outcome: ${summary.run.outcome}`,
    `- Source DB snapshot: ${summary.run.sourceDatabase}`,
    `- Source sessions: ${summary.run.sourceSessionCount}`,
    `- Source projects: ${summary.run.sourceProjectCount}`,
    ...summary.run.details.map(
      (detail) => `- ${detail.label}: ${detail.value}`
    ),
    `- Stability criterion: ${summary.run.stabilityCriterion}`,
    `- Recovery rows removed from isolated copy: ${summary.run.clearedRecoveryRows}`,
    "",
    "| Assertion | Result |",
    "| --- | --- |",
    ...summary.run.assertions.map(
      (assertion) =>
        `| ${assertion.name} | ${assertion.passed ? "pass" : "fail"} |`
    ),
    ""
  ].join("\n");
  return traceMarkdown.replace(
    "## Phase timings",
    `${runLines}\n## Phase timings`
  );
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function defaultOutputDirectory(scenarioID, date) {
  const stamp = date
    .toISOString()
    .replaceAll(":", "")
    .replaceAll("-", "")
    .replace(/\.\d{3}Z$/u, "Z");
  return join(workspaceRoot, ".tmp", "perf", "agent-gui", scenarioID, stamp);
}

function parseArgs(argv) {
  const options = {
    sourceDatabase: join(homedir(), ".tutti-dev", "tuttid.db"),
    minimumLongEventMs: 16,
    scenario: "provider-switch"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--source-db") {
      options.sourceDatabase = resolve(requiredValue(argv, (index += 1), arg));
    } else if (arg === "--output") {
      options.outputDirectory = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--scenario") {
      options.scenario = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--list-scenarios") {
      options.listScenarios = true;
    } else if (arg === "--from-target-id") {
      options.fromTargetID = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--to-target-id") {
      options.toTargetID = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--min-ms") {
      options.minimumLongEventMs = positiveNumber(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--keep-runtime") {
      options.keepRuntime = true;
    } else if (arg === "--all-process-time-profile") {
      options.allProcessTimeProfile = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return number;
}

function isMainModule() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

function targetIDFromWebSocket(webSocketURL) {
  const targetID = new URL(webSocketURL).pathname
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!targetID) throw new Error("could not resolve CDP page target id");
  return targetID;
}

function log(message) {
  process.stderr.write(`[perf:agent-gui] ${message}\n`);
}

function printUsage() {
  process.stdout.write(
    `Run an isolated, report-only AgentGUI performance scenario.\n\nUsage:\n  pnpm perf:agent-gui\n  pnpm perf:agent-gui -- --scenario session-switch\n  pnpm perf:agent-gui -- --list-scenarios\n\nOptions:\n  --scenario <id>          Scenario. Default: provider-switch\n  --list-scenarios         Print available scenario ids\n  --source-db <path>       Source dev DB. Default: ~/.tutti-dev/tuttid.db\n  --output <directory>     Report/trace output directory under .tmp by default\n  --from-target-id <id>    Source Agent target for provider scenarios\n  --to-target-id <id>      Target Agent target for provider scenarios\n  --min-ms <milliseconds>  Long-event threshold. Default: 16\n  --all-process-time-profile\n                           Also record macOS Time Profiler for all processes\n  --keep-runtime           Keep isolated DB and Electron userData for debugging\n`
  );
  process.stdout.write(
    "\n--min-ms applies to renderer-main RunTask duration, not all trace events.\n"
  );
}
