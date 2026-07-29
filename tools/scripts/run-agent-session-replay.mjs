#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CdpClient } from "./capture-electron-trace.mjs";
import {
  selectProvider,
  selectSession,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";
import { enterAndSubmitComposerPrompt } from "./agent-gui-layout-performance-scenarios.mjs";
import {
  buildDaemon,
  reservePort,
  startDesktop,
  stopProcessTree,
  waitForPageWebSocket
} from "./run-agent-gui-performance.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..", "..");
const defaultTimeoutMs = 180_000;
export const managedReplayReadyPrefix = "[tutti-agent-session-replay-ready] ";
export const managedReplayCompletePrefix =
  "[tutti-agent-session-replay-complete] ";
export const managedReplayFailedPrefix = "[tutti-agent-session-replay-failed] ";
export const managedReplayCheckpointPrefix =
  "[tutti-agent-session-replay-checkpoint] ";
export const managedReplayReplacePrefix =
  "[tutti-agent-session-replay-replace] ";
export const cassettePolicy = JSON.parse(
  await readFile(
    join(
      workspaceRoot,
      "packages",
      "agent",
      "session-replay",
      "cassette-policy.json"
    ),
    "utf8"
  )
);
const scenarioName = cassettePolicy.files.scenario.path;
const activityEventsName = cassettePolicy.files.activityEvents.path;
const checkpointsName = cassettePolicy.files.checkpoints.path;
const providerManifestName = cassettePolicy.files.providerManifest.path;
const blobManifestName = cassettePolicy.files.blobManifest.path;
const cassetteManifestName = cassettePolicy.files.cassetteManifest.path;
const maxCassetteBytes = cassettePolicy.limits.maxCassetteBytes;
const fixtureTableScopes = {
  workspace_agent_sessions: "agent_session_id",
  workspace_agent_turns: "agent_session_id",
  workspace_agent_messages: "agent_session_id",
  workspace_agent_interactions: "agent_session_id",
  workspace_agent_submit_claims: "agent_session_id",
  workspace_agent_runtime_operations: "agent_session_id",
  workspace_agent_runtime_operation_events: "agent_session_id",
  workspace_agent_session_goals: "agent_session_id",
  workspace_agent_goal_control_operations: "agent_session_id",
  workspace_agent_goal_provenance_ledger: "agent_session_id",
  workspace_agent_goal_repair_incidents: "agent_session_id",
  workspace_agent_goal_reconcile_inbox: "agent_session_id",
  tutti_mode_activations: "agent_session_id",
  tutti_mode_turn_snapshots: "agent_session_id",
  tutti_mode_activation_revisions: "activation_id",
  workspace_workflow_turn_links: "turn_id",
  workspace_workflows: "workflow_id",
  tutti_mode_plans: "workflow_id",
  workspace_workflow_plan_revisions: "workflow_id",
  workspace_workflow_checkpoints: "workflow_id",
  workspace_workflow_mutations: "workflow_id",
  workspace_workflow_operations: "workflow_id",
  workspace_issues: "issue_id",
  workspace_issue_tasks: "issue_id",
  workspace_issue_context_refs: "issue_id",
  workspace_issue_runs: "issue_id",
  workspace_issue_run_outputs: "issue_id"
};

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `[agent-session-replay] ${error.stack ?? error.message}\n`
    );
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  if (options.mode === "record") {
    await recordCassette(options);
  } else {
    await replayCassette(options);
  }
}

async function recordCassette(options) {
  await ensureEmptyDirectory(options.cassetteDirectory);
  const runtime = await createRuntime("record");
  const databasePath = join(runtime.stateDirectory, "tuttid.db");
  let succeeded = false;
  try {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    await initializeCleanDatabase(runtime, workspaceId);
    await enableAgentSessionRecordingFeature(databasePath);
    const tokenBase =
      options.expectedToken ??
      `TUTTI_REPLAY_MVP_${new Date().toISOString().replaceAll(/[^0-9A-Z]/giu, "")}`;
    const prompts = options.prompt
      ? [options.prompt]
      : [1, 2, 3].map(
          (index) => `Reply with exactly this text: ${tokenBase}_${index}`
        );
    const action = {
      schemaVersion: 1,
      type: "create-session",
      workspaceId,
      agentTargetId: "local:codex",
      prompts,
      expectedTokens: prompts.map((prompt) =>
        prompt.slice("Reply with exactly this text: ".length)
      )
    };
    const result = await runDesktopAction({
      action,
      artifactDirectory: join(runtime.directory, "artifacts"),
      cassetteDirectory: options.cassetteDirectory,
      daemonPath: runtime.daemonPath,
      headless: options.headless,
      logPath: join(runtime.directory, "logs", "desktop.log"),
      mode: "record",
      runtime,
      timeoutMs: options.timeoutMs
    });
    await waitForCompleteManifest(
      join(result.recordingDirectory, providerManifestName),
      15_000
    );
    for (const name of [
      scenarioName,
      "environment.json",
      activityEventsName,
      checkpointsName,
      "seed",
      "provider",
      "expected",
      "blobs",
      "cassette.json"
    ]) {
      const source = join(result.recordingDirectory, name);
      await cp(source, join(options.cassetteDirectory, name), {
        force: true,
        recursive: true
      });
    }
    succeeded = true;
    log(`recorded ${basename(options.cassetteDirectory)}`);
    log(`assistant: ${result.assistantText}`);
  } finally {
    if (!options.keepRuntime) {
      await removeRuntime(runtime.directory);
    } else {
      log(`runtime kept: ${runtime.directory}`);
    }
    if (!succeeded) {
      log(`incomplete cassette kept: ${options.cassetteDirectory}`);
    }
  }
}

async function replayCassette(options) {
  await verifyCassette(options.cassetteDirectory);
  await Promise.all([
    access(join(options.cassetteDirectory, scenarioName)),
    access(join(options.cassetteDirectory, activityEventsName)),
    access(join(options.cassetteDirectory, providerManifestName)),
    access(join(options.cassetteDirectory, "expected", "state.jsonl")),
    access(join(options.cassetteDirectory, blobManifestName)),
    access(join(options.cassetteDirectory, cassetteManifestName))
  ]);
  const portableScenario = JSON.parse(
    await readFile(join(options.cassetteDirectory, scenarioName), "utf8")
  );
  const scenario = {
    ...portableScenario,
    workspaceId: portableScenario.scopeId
  };
  const activityEvents = parseActivityEvents(
    await readFile(join(options.cassetteDirectory, activityEventsName), "utf8")
  );
  const checkpoints = parseReplayCheckpoints(
    await readFile(join(options.cassetteDirectory, checkpointsName), "utf8"),
    activityEvents
  );
  const action = replayActionFromScenario(scenario, activityEvents);
  const runtime = await createRuntime("replay");
  const desktopLogPath = join(runtime.directory, "logs", "desktop.log");
  const statusPath = join(runtime.directory, "replay-status.json");
  const controlPath = join(runtime.directory, "replay-control.json");
  let succeeded = false;
  try {
    await mkdir(dirname(desktopLogPath), { recursive: true });
    await initializeCleanDatabase(runtime, scenario.workspaceId);
    await materializeCassetteBlobs(
      options.cassetteDirectory,
      runtime.stateDirectory
    );
    if (scenario.mode === "continue-session") {
      await importFixture(
        join(runtime.stateDirectory, "tuttid.db"),
        join(options.cassetteDirectory, "seed", "state.jsonl")
      );
    }
    await seedReplayUserProjects(
      join(runtime.stateDirectory, "tuttid.db"),
      replayUserProjectPaths(action)
    );
    const result = await runDesktopAction({
      action,
      artifactDirectory: join(runtime.directory, "artifacts"),
      cassetteDirectory: options.cassetteDirectory,
      checkpoints,
      controlPath,
      daemonPath: runtime.daemonPath,
      desktopLaunch: options.managed ? managedDesktopLaunch() : undefined,
      headless: options.managed ? false : options.headless,
      keepDesktopOpen: options.managed,
      logPath: desktopLogPath,
      mode: "replay",
      initialTargetCheckpoint: options.targetCheckpoint,
      onCheckpoint: options.managed
        ? (checkpoint) => {
            process.stdout.write(
              `${managedReplayCheckpointPrefix}${JSON.stringify({
                checkpoint,
                runId: options.runId
              })}\n`
            );
          }
        : undefined,
      onCompleted: options.managed
        ? () => {
            process.stdout.write(
              `${managedReplayCompletePrefix}${JSON.stringify({
                runId: options.runId
              })}\n`
            );
          }
        : undefined,
      onFailed: options.managed
        ? (error) => {
            process.stdout.write(
              `${managedReplayFailedPrefix}${JSON.stringify({
                error: replayStatusErrorMessage(error),
                runId: options.runId
              })}\n`
            );
          }
        : undefined,
      onSurfaceReady: options.managed
        ? () => {
            process.stdout.write(
              `${managedReplayReadyPrefix}${JSON.stringify({
                runId: options.runId,
                runtimeDirectory: runtime.directory
              })}\n`
            );
          }
        : undefined,
      onReplacement: options.managed
        ? (replacement) => {
            process.stdout.write(
              `${managedReplayReplacePrefix}${JSON.stringify({
                ...replacement,
                runId: options.runId
              })}\n`
            );
          }
        : undefined,
      runtime,
      statusPath,
      timeoutMs: options.timeoutMs,
      verifyResult: async (desktopResult) => {
        await verifyReplayTransport(runtime.stateDirectory, options.timeoutMs);
        const replayLog = await readFile(desktopLogPath, "utf8");
        const failureLine = replayLog
          .split("\n")
          .find(
            (line) =>
              line.includes("process cassette outbound mismatch") ||
              line.includes("process_transport.finalize_failed")
          );
        if (failureLine) {
          throw new Error(`replay transport failed: ${failureLine.trim()}`);
        }
        await compareExpectedFixture(
          join(runtime.stateDirectory, "tuttid.db"),
          join(options.cassetteDirectory, "expected", "state.jsonl"),
          scenario,
          desktopResult.activeSessionId
        );
      }
    });
    if (result.replaced) {
      succeeded = true;
      return;
    }
    succeeded = true;
    log(`replay passed: ${basename(options.cassetteDirectory)}`);
    log(`assistant: ${result.assistantText}`);
  } finally {
    if (!options.keepRuntime) {
      await removeRuntime(runtime.directory);
    } else {
      log(`runtime kept: ${runtime.directory}`);
    }
    if (!succeeded) {
      log("replay failed; cassette was left unchanged");
    }
  }
}

export async function verifyCassette(directory) {
  const manifest = JSON.parse(
    await readFile(join(directory, cassetteManifestName), "utf8")
  );
  if (
    manifest.schemaVersion !== cassettePolicy.schemaVersion ||
    manifest.maxTotalBytes !== cassettePolicy.limits.maxCassetteBytes ||
    !Array.isArray(manifest.files) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0
  ) {
    throw new Error("cassette manifest is invalid or unsupported");
  }
  const blobManifest = JSON.parse(
    await readFile(join(directory, blobManifestName), "utf8")
  );
  if (
    blobManifest.schemaVersion !== cassettePolicy.blobManifestSchemaVersion ||
    !Array.isArray(blobManifest.blobs)
  ) {
    throw new Error("cassette blob manifest is invalid or unsupported");
  }
  const policyFiles = new Map(
    Object.values(cassettePolicy.files)
      .filter((file) => file.inventory !== false)
      .map((file) => [file.path, file])
  );
  for (const blob of blobManifest.blobs) {
    const digest =
      typeof blob.sha256 === "string" ? blob.sha256.toLowerCase() : "";
    if (
      !/^[0-9a-f]{64}$/u.test(digest) ||
      !Number.isSafeInteger(blob.sizeBytes) ||
      blob.sizeBytes < 0 ||
      blob.sizeBytes > cassettePolicy.limits.maxPortableBlobBytes
    ) {
      throw new Error(
        `cassette blob has invalid integrity evidence: ${digest}`
      );
    }
    policyFiles.set(`blobs/sha256/${digest}`, {
      path: `blobs/sha256/${digest}`,
      role: "referenced-blob"
    });
  }
  const expected = new Map();
  for (const file of manifest.files) {
    const path = typeof file.path === "string" ? file.path : "";
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === ".."
        ) ||
      expected.has(path)
    ) {
      throw new Error(`cassette manifest has invalid file path: ${path}`);
    }
    const policyFile = policyFiles.get(path);
    if (!policyFile || file.role !== policyFile.role) {
      throw new Error(`cassette contains unrelated file: ${path}`);
    }
    if (
      path === cassettePolicy.files.providerFrames.path &&
      file.sizeBytes > cassettePolicy.limits.maxProviderTapeBytes
    ) {
      throw new Error(`provider tape size limit exceeded: ${file.sizeBytes}`);
    }
    expected.set(path, file);
  }
  for (const file of Object.values(cassettePolicy.files)) {
    if (file.required && !expected.has(file.path)) {
      throw new Error(`cassette is missing required file: ${file.path}`);
    }
  }
  const actualPaths = await listCassetteFiles(directory);
  const allowedPaths = new Set([...expected.keys(), cassetteManifestName]);
  for (const path of actualPaths) {
    if (!allowedPaths.has(path)) {
      throw new Error(`cassette contains unrelated file: ${path}`);
    }
  }
  let totalBytes = 0;
  for (const [path, file] of expected) {
    if (!actualPaths.includes(path)) {
      throw new Error(`cassette is missing manifest file: ${path}`);
    }
    const actual = await hashFile(join(directory, ...path.split("/")));
    if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256) {
      throw new Error(`cassette file integrity mismatch: ${path}`);
    }
    totalBytes += actual.sizeBytes;
    if (totalBytes > maxCassetteBytes) {
      throw new Error(
        `cassette size limit exceeded: total=${totalBytes} limit=${maxCassetteBytes}`
      );
    }
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error(
      `cassette total size mismatch: actual=${totalBytes} manifest=${manifest.totalBytes}`
    );
  }
  return manifest;
}

async function listCassetteFiles(root) {
  const result = [];
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        result.push(relative);
      } else {
        throw new Error(`cassette contains unsupported file: ${relative}`);
      }
    }
  }
  await visit(root, "");
  return result.sort();
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function createRuntime(mode) {
  const runtimeParent = join(workspaceRoot, ".tmp");
  await mkdir(runtimeParent, { recursive: true });
  const directory = await mkdtemp(
    join(runtimeParent, `agent-session-${mode}-`)
  );
  const stateDirectory = join(directory, "state");
  const userDataDirectory = join(directory, "electron-user-data");
  const daemonPath = join(directory, "tuttid");
  await mkdir(stateDirectory, { recursive: true });
  await runCommand("pnpm", ["generate:builtin-apps"]);
  await buildDaemon(daemonPath);
  return {
    daemonPath,
    directory,
    stateDirectory,
    userDataDirectory
  };
}

function managedDesktopLaunch() {
  const command =
    process.env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE?.trim();
  if (!command) {
    throw new Error("managed replay Electron executable is unavailable");
  }
  const entry = process.env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY?.trim();
  return {
    args: entry ? [entry] : [],
    command
  };
}

async function initializeCleanDatabase(runtime, workspaceId) {
  const listenerInfoPath = join(
    runtime.stateDirectory,
    "run",
    "tuttid.listener.json"
  );
  const daemon = spawn(runtime.daemonPath, [], {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      TUTTI_ANALYTICS_DISABLED: "1",
      TUTTI_ENV: "development",
      TUTTI_STATE_DIR: runtime.stateDirectory,
      TUTTID_ADDR: "127.0.0.1:0",
      TUTTID_ACCESS_TOKEN: randomUUID()
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let daemonStdout = "";
  let daemonStderr = "";
  daemon.stdout.on("data", (chunk) => {
    daemonStdout += chunk.toString();
  });
  daemon.stderr.on("data", (chunk) => {
    daemonStderr += chunk.toString();
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null || daemon.signalCode !== null) {
        throw new Error(
          `tuttid exited while initializing a clean database: ${(
            daemonStderr.trim() ||
            daemonStdout.trim() ||
            daemon.signalCode ||
            daemon.exitCode
          )
            .toString()
            .slice(-4_000)}`
        );
      }
      try {
        await access(listenerInfoPath);
        break;
      } catch {
        await delay(50);
      }
    }
    await access(listenerInfoPath);
  } finally {
    await stopProcessTree(daemon);
  }
  const databasePath = join(runtime.stateDirectory, "tuttid.db");
  const now = Date.now();
  const workbenchSnapshot = replayWorkbenchSnapshot(
    new Date(now).toISOString()
  );
  await runCommand("sqlite3", [
    databasePath,
    `
PRAGMA foreign_keys = ON;
INSERT INTO workspaces (
  id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms
) VALUES (
  '${sqlString(workspaceId)}', 'Replay Scenario', ${now}, ${now}, ${now}
);
INSERT INTO desktop_preferences (
  id, locale, theme_source, updated_at_unix_ms
) VALUES (
  'desktop', 'en', 'system', ${now}
)
ON CONFLICT(id) DO NOTHING;
INSERT INTO workspace_workbench_snapshots (
  workspace_id,
  schema_version,
  snapshot_json,
  created_at_unix_ms,
  updated_at_unix_ms
) VALUES (
  '${sqlString(workspaceId)}',
  ${workbenchSnapshot.schemaVersion},
  '${sqlString(JSON.stringify(workbenchSnapshot))}',
  ${now},
  ${now}
);
`
  ]);
}

export function replayWorkbenchSnapshot(autoOpenedAt) {
  return {
    schemaVersion: 1,
    nodes: [],
    nodeStack: [],
    activeNodeId: null,
    metadata: {
      workspaceOnboarding: {
        autoOpened: true,
        autoOpenedAt,
        schemaVersion: 1
      }
    }
  };
}

export function replayUserProjectPaths(action) {
  return [
    ...new Set(
      action.activityEvents
        .flatMap((event) => [
          event.payload?.railPlacement?.projectPath,
          event.payload?.cwd
        ])
        .filter((path) => typeof path === "string" && path.trim())
        .map((path) => path.trim())
    )
  ];
}

async function seedReplayUserProjects(databasePath, projectPaths) {
  const now = Date.now();
  const values = projectPaths.map((path, index) => ({
    id: `replay-project-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
    label: basename(path),
    path,
    sortOrder: index
  }));
  const explicitProjects = values
    .map(
      (project) =>
        `('${sqlString(project.id)}', '${sqlString(project.path)}', '${sqlString(project.label)}', ${now}, ${now}, ${now}, 0, ${project.sortOrder})`
    )
    .join(",\n");
  await runCommand("sqlite3", [
    databasePath,
    `
${explicitProjects ? `INSERT INTO user_projects (id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms, pinned_at_unix_ms, sort_order) VALUES\n${explicitProjects}\nON CONFLICT(path) DO NOTHING;` : ""}
INSERT INTO user_projects (
  id, path, label, created_at_unix_ms, updated_at_unix_ms,
  last_used_at_unix_ms, pinned_at_unix_ms, sort_order
)
SELECT
  'replay-project-' || lower(hex(randomblob(8))),
  rail_project_path,
  replace(rail_project_path, rtrim(rail_project_path, replace(rail_project_path, '/', '')), ''),
  ${now}, ${now}, ${now}, 0,
  (SELECT COUNT(*) FROM user_projects)
FROM workspace_agent_sessions
WHERE rail_section_kind = 'project' AND trim(rail_project_path) <> ''
GROUP BY rail_project_path
ON CONFLICT(path) DO NOTHING;
`
  ]);
}

async function importFixture(databasePath, fixturePath) {
  const records = parseJSONLines(await readFile(fixturePath, "utf8"));
  const statements = [
    "PRAGMA foreign_keys = ON;",
    "BEGIN;",
    "PRAGMA defer_foreign_keys = ON;"
  ];
  for (const record of records) {
    validateFixtureRecord(record);
    const columns = Object.keys(record.values);
    statements.push(
      `INSERT INTO ${sqlIdentifier(record.table)} (${columns.map(sqlIdentifier).join(",")}) VALUES (${columns
        .map((column) => sqlValue(record.values[column]))
        .join(",")});`
    );
  }
  statements.push("COMMIT;");
  await runCommand("sqlite3", [databasePath, statements.join("\n")]);
}

export async function materializeCassetteBlobs(
  cassetteDirectory,
  stateDirectory
) {
  const manifest = JSON.parse(
    await readFile(join(cassetteDirectory, blobManifestName), "utf8")
  );
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.blobs)) {
    throw new Error("cassette blob manifest is invalid");
  }
  const targets = new Set();
  for (const entry of manifest.blobs) {
    validateBlobEntry(entry);
    const key = `${entry.agentSessionId}\0${entry.attachmentId}\0${entry.mimeType}`;
    if (targets.has(key)) {
      throw new Error(`duplicate cassette blob target: ${key}`);
    }
    targets.add(key);
    const source = join(cassetteDirectory, "blobs", "sha256", entry.sha256);
    const data = await readFile(source);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== entry.sha256 || data.byteLength !== entry.sizeBytes) {
      throw new Error(`cassette blob integrity mismatch: ${entry.sha256}`);
    }
    const destination = join(
      stateDirectory,
      "agent",
      "attachments",
      entry.agentSessionId,
      `${entry.attachmentId}${promptImageExtension(entry.mimeType)}`
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data, { mode: 0o600 });
  }
}

function validateBlobEntry(entry) {
  if (
    entry?.kind !== "agent-prompt-attachment" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0 ||
    !safePathSegment(entry.agentSessionId) ||
    !safePathSegment(entry.attachmentId) ||
    !promptImageExtension(entry.mimeType)
  ) {
    throw new Error("cassette blob entry is invalid or unsupported");
  }
}

function safePathSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function promptImageExtension(mimeType) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

async function compareExpectedFixture(
  databasePath,
  fixturePath,
  scenario,
  actualRootSessionId
) {
  const expectedRecords = parseJSONLines(await readFile(fixturePath, "utf8"));
  for (const record of expectedRecords) validateFixtureRecord(record);
  const expectedByTable = new Map();
  for (const record of expectedRecords) {
    const rows = expectedByTable.get(record.table) ?? [];
    rows.push(record);
    expectedByTable.set(record.table, rows);
  }
  const identityMap = new Map([
    [scenario.rootAgentSessionId, actualRootSessionId]
  ]);
  await addSessionIdentityMappings(
    databasePath,
    scenario,
    expectedByTable.get("workspace_agent_sessions") ?? [],
    identityMap
  );
  await addTurnIdentityMappings(
    databasePath,
    scenario,
    expectedByTable.get("workspace_agent_submit_claims") ?? [],
    identityMap
  );
  await addRemainingTurnIdentityMappings(
    databasePath,
    scenario,
    expectedByTable.get("workspace_agent_turns") ?? [],
    identityMap
  );
  await addMessageIdentityMappings(
    databasePath,
    scenario,
    expectedByTable.get("workspace_agent_messages") ?? [],
    identityMap
  );
  await addTurnCompletedMessageIdentityMappings(
    databasePath,
    scenario,
    expectedByTable.get("workspace_agent_turns") ?? [],
    identityMap
  );
  await addOperationIdentityMappings(
    databasePath,
    scenario,
    expectedByTable,
    identityMap
  );
  const sessions = (expectedByTable.get("workspace_agent_sessions") ?? []).map(
    (record) =>
      identityMap.get(record.values.agent_session_id) ??
      record.values.agent_session_id
  );
  const turns = (expectedByTable.get("workspace_agent_turns") ?? []).map(
    (record) => mappedIdentity(record.values.turn_id, identityMap)
  );
  const workflows = (expectedByTable.get("workspace_workflows") ?? []).map(
    (record) => mappedIdentity(record.values.workflow_id, identityMap)
  );
  const activations = (expectedByTable.get("tutti_mode_activations") ?? []).map(
    (record) => mappedIdentity(record.values.activation_id, identityMap)
  );
  const issues = (expectedByTable.get("workspace_issues") ?? []).map((record) =>
    mappedIdentity(record.values.issue_id, identityMap)
  );
  const identitiesByScope = {
    agent_session_id: sessions,
    workflow_id: workflows,
    turn_id: turns,
    activation_id: activations,
    issue_id: issues
  };
  for (const [table, identityColumn] of Object.entries(fixtureTableScopes)) {
    const expected = expectedByTable.get(table) ?? [];
    const identities = identitiesByScope[identityColumn];
    if (identities.length === 0) continue;
    const actual = await sqliteJSON(
      databasePath,
      `SELECT * FROM ${sqlIdentifier(table)}
       WHERE workspace_id = '${sqlString(scenario.workspaceId)}'
         AND ${sqlIdentifier(identityColumn)} IN (${identities
           .map((value) => `'${sqlString(value)}'`)
           .join(",")})
       ORDER BY rowid;`
    );
    const normalizedExpected = expected
      .map((record) =>
        normalizeReplayFixtureRecord(table, record.values, identityMap)
      )
      .map(stableJSON)
      .sort();
    const normalizedActual = actual
      .map((values) => normalizeReplayFixtureRecord(table, values))
      .map(stableJSON)
      .sort();
    if (stableJSON(normalizedActual) !== stableJSON(normalizedExpected)) {
      throw new Error(
        `expected state mismatch in ${table}\nexpected: ${stableJSON(normalizedExpected)}\nactual: ${stableJSON(normalizedActual)}`
      );
    }
  }
}

async function addSessionIdentityMappings(
  databasePath,
  scenario,
  expectedSessions,
  identityMap
) {
  if (expectedSessions.length === 0) return;
  const actualSessions = await sqliteJSON(
    databasePath,
    `SELECT * FROM workspace_agent_sessions
     WHERE workspace_id = '${sqlString(scenario.workspaceId)}'
     ORDER BY rowid;`
  );
  mapReplaySessionIdentities(
    expectedSessions.map((record) => record.values),
    actualSessions,
    identityMap
  );
}

export function mapReplaySessionIdentities(
  expectedSessions,
  actualSessions,
  identityMap
) {
  const expectedByKey = uniqueReplayRowsByKey(
    expectedSessions,
    replaySessionIdentityKey
  );
  const actualByKey = uniqueReplayRowsByKey(
    actualSessions,
    replaySessionIdentityKey
  );
  const mappedActualIdentities = new Set(identityMap.values());
  for (const expected of expectedSessions) {
    if (identityMap.has(expected.agent_session_id)) continue;
    const key = replaySessionIdentityKey(expected);
    if (!key || expectedByKey.get(key) !== expected) continue;
    const actual = actualByKey.get(key);
    if (!actual || mappedActualIdentities.has(actual.agent_session_id)) {
      continue;
    }
    mapIdentity(
      expected.agent_session_id,
      actual.agent_session_id,
      identityMap
    );
    mappedActualIdentities.add(actual.agent_session_id);
  }
}

function replaySessionIdentityKey(session) {
  const values = [
    session.agent_target_id,
    session.provider,
    session.provider_session_id,
    session.session_kind
  ];
  return values.every((value) => typeof value === "string" && value.trim())
    ? values.join("\0")
    : null;
}

function uniqueReplayRowsByKey(rows, keyForRow) {
  const unique = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    if (!key) continue;
    unique.set(key, unique.has(key) ? null : row);
  }
  return unique;
}

async function addMessageIdentityMappings(
  databasePath,
  scenario,
  expectedMessages,
  identityMap
) {
  if (expectedMessages.length === 0) return;
  const actualMessages = await sqliteJSON(
    databasePath,
    `SELECT * FROM workspace_agent_messages
     WHERE workspace_id = '${sqlString(scenario.workspaceId)}';`
  );
  for (const expectedRecord of expectedMessages) {
    const expected = expectedRecord.values;
    const actual = actualMessages.find(
      (candidate) =>
        mappedIdentity(expected.agent_session_id, identityMap) ===
          candidate.agent_session_id &&
        mappedIdentity(expected.turn_id, identityMap) === candidate.turn_id &&
        expected.version === candidate.version &&
        expected.role === candidate.role &&
        expected.kind === candidate.kind
    );
    if (!actual) continue;
    mapIdentity(expected.message_id, actual.message_id, identityMap);
    mapAlignedAttachmentIdentities(
      parseJSONValue(expected.payload_json),
      parseJSONValue(actual.payload_json),
      identityMap
    );
  }
}

async function addTurnCompletedMessageIdentityMappings(
  databasePath,
  scenario,
  expectedTurns,
  identityMap
) {
  if (expectedTurns.length === 0) return;
  const actualTurns = await sqliteJSON(
    databasePath,
    `SELECT * FROM workspace_agent_turns
     WHERE workspace_id = '${sqlString(scenario.workspaceId)}';`
  );
  for (const expectedRecord of expectedTurns) {
    const expected = expectedRecord.values;
    const actual = actualTurns.find(
      (candidate) =>
        candidate.turn_id === mappedIdentity(expected.turn_id, identityMap)
    );
    if (!actual) continue;
    const expectedCompleted = parseJSONValue(expected.completed_command_json);
    const actualCompleted = parseJSONValue(actual.completed_command_json);
    mapIdentity(
      expectedCompleted?.finalAssistantMessageId,
      actualCompleted?.finalAssistantMessageId,
      identityMap
    );
  }
}

async function addOperationIdentityMappings(
  databasePath,
  scenario,
  expectedByTable,
  identityMap
) {
  const definitions = [
    {
      table: "workspace_agent_runtime_operations",
      identities: ["operation_id"],
      stable: ["agent_session_id", "kind", "turn_id", "request_id"]
    },
    {
      table: "workspace_agent_goal_control_operations",
      identities: ["operation_id", "client_submit_id"],
      stable: ["agent_session_id", "goal_revision", "action"]
    },
    {
      table: "tutti_mode_activations",
      identities: ["activation_id", "current_revision_id"],
      stable: ["agent_session_id"]
    },
    {
      table: "workspace_workflow_turn_links",
      identities: ["workflow_id"],
      stable: ["turn_id", "relation"]
    },
    {
      table: "tutti_mode_activation_revisions",
      identities: ["revision_id"],
      stable: ["activation_id", "revision"]
    },
    {
      table: "workspace_workflow_plan_revisions",
      identities: ["revision_id"],
      stable: ["workflow_id", "revision_sequence"]
    },
    {
      table: "workspace_workflow_checkpoints",
      identities: ["checkpoint_id", "revision_id"],
      stable: ["workflow_id", "kind", "revision_id"]
    },
    {
      table: "workspace_workflow_operations",
      identities: ["operation_id", "revision_id", "issue_id"],
      stable: ["workflow_id", "kind", "revision_id"]
    },
    {
      table: "workspace_issue_runs",
      identities: ["run_id"],
      stable: ["issue_id", "task_id", "agent_session_id"]
    }
  ];
  for (const definition of definitions) {
    const expectedRecords = expectedByTable.get(definition.table) ?? [];
    if (expectedRecords.length === 0) continue;
    const actualRows = await sqliteJSON(
      databasePath,
      `SELECT * FROM ${sqlIdentifier(definition.table)}
       WHERE workspace_id = '${sqlString(scenario.workspaceId)}';`
    );
    for (const expectedRecord of expectedRecords) {
      const expected = expectedRecord.values;
      const actual = actualRows.find((candidate) =>
        definition.stable.every(
          (column) =>
            mappedIdentity(expected[column], identityMap) === candidate[column]
        )
      );
      if (actual) {
        for (const identity of definition.identities) {
          mapIdentity(expected[identity], actual[identity], identityMap);
        }
      }
    }
  }
}

function mapAlignedAttachmentIdentities(expected, actual, identityMap) {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (
      let index = 0;
      index < Math.min(expected.length, actual.length);
      index += 1
    ) {
      mapAlignedAttachmentIdentities(
        expected[index],
        actual[index],
        identityMap
      );
    }
    return;
  }
  if (
    !expected ||
    !actual ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return;
  }
  if (expected.type === "image" && actual.type === "image") {
    mapIdentity(expected.attachmentId, actual.attachmentId, identityMap);
  }
  for (const key of Object.keys(expected)) {
    if (key in actual) {
      mapAlignedAttachmentIdentities(expected[key], actual[key], identityMap);
    }
  }
}

function parseJSONValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mappedIdentity(value, identityMap) {
  return typeof value === "string" ? (identityMap.get(value) ?? value) : value;
}

function mapIdentity(expected, actual, identityMap) {
  if (
    typeof expected === "string" &&
    expected &&
    typeof actual === "string" &&
    actual
  ) {
    identityMap.set(expected, actual);
  }
}

async function addTurnIdentityMappings(
  databasePath,
  scenario,
  expectedClaims,
  identityMap
) {
  if (expectedClaims.length === 0) return;
  const actualClaims = await sqliteJSON(
    databasePath,
    `SELECT * FROM workspace_agent_submit_claims
     WHERE workspace_id = '${sqlString(scenario.workspaceId)}';`
  );
  for (const expectedRecord of expectedClaims) {
    const expected = expectedRecord.values;
    const mappedSession =
      identityMap.get(expected.agent_session_id) ?? expected.agent_session_id;
    const actual = actualClaims.find(
      (candidate) =>
        candidate.agent_session_id === mappedSession &&
        candidate.client_submit_id === expected.client_submit_id
    );
    if (!actual) continue;
    for (const column of ["turn_id", "canonical_turn_id"]) {
      if (expected[column] && actual[column]) {
        identityMap.set(expected[column], actual[column]);
      }
    }
  }
}

async function addRemainingTurnIdentityMappings(
  databasePath,
  scenario,
  expectedTurns,
  identityMap
) {
  if (expectedTurns.length === 0) return;
  const actualTurns = await sqliteJSON(
    databasePath,
    `SELECT * FROM workspace_agent_turns
     WHERE workspace_id = '${sqlString(scenario.workspaceId)}'
     ORDER BY rowid;`
  );
  mapReplayTurnIdentitiesBySessionOrder(
    expectedTurns.map((record) => record.values),
    actualTurns,
    identityMap
  );
}

export function mapReplayTurnIdentitiesBySessionOrder(
  expectedTurns,
  actualTurns,
  identityMap
) {
  const mappedActualIdentities = new Set(identityMap.values());
  const expectedBySession = new Map();
  const actualBySession = new Map();
  for (const expected of expectedTurns) {
    if (
      typeof expected.turn_id !== "string" ||
      !expected.turn_id ||
      identityMap.has(expected.turn_id)
    ) {
      continue;
    }
    const sessionID = mappedIdentity(expected.agent_session_id, identityMap);
    const turns = expectedBySession.get(sessionID) ?? [];
    turns.push(expected);
    expectedBySession.set(sessionID, turns);
  }
  for (const actual of actualTurns) {
    if (
      typeof actual.turn_id !== "string" ||
      !actual.turn_id ||
      mappedActualIdentities.has(actual.turn_id)
    ) {
      continue;
    }
    const turns = actualBySession.get(actual.agent_session_id) ?? [];
    turns.push(actual);
    actualBySession.set(actual.agent_session_id, turns);
  }
  for (const [sessionID, expected] of expectedBySession) {
    const actual = actualBySession.get(sessionID) ?? [];
    if (actual.length !== expected.length) continue;
    for (let index = 0; index < expected.length; index += 1) {
      mapIdentity(expected[index].turn_id, actual[index].turn_id, identityMap);
    }
  }
}

export function replayActionFromScenario(scenario, activityEvents) {
  if (
    scenario?.schemaVersion !== 1 ||
    !["create-session", "continue-session"].includes(scenario.mode) ||
    !scenario.scopeId ||
    scenario.workspaceId !== scenario.scopeId ||
    !scenario.agentTargetId ||
    !scenario.rootAgentSessionId
  ) {
    throw new Error("cassette scenario is invalid or unsupported");
  }
  const prompts = activityEvents
    .filter((event) =>
      ["session.create", "session.send", "submit/requested"].includes(
        event.type
      )
    )
    .map((event) => stimulusPrompt(event.payload))
    .filter(Boolean);
  if (activityEvents.length === 0) {
    throw new Error("cassette has no replayable activity events");
  }
  const productActivityEvents = activityEvents.map((event) => {
    if (event.scopeId !== scenario.scopeId) {
      throw new Error(
        "cassette activity event Scope does not match its scenario"
      );
    }
    return {
      ...event,
      workspaceId: event.scopeId
    };
  });
  return {
    type: scenario.mode,
    workspaceId: scenario.workspaceId,
    agentTargetId: scenario.agentTargetId,
    agentSessionId: scenario.rootAgentSessionId,
    prompts,
    expectedTokens: prompts.map(() => ""),
    activityEvents: productActivityEvents
  };
}

export function parseActivityEvents(contents) {
  const events = parseJSONLines(contents);
  const eventKinds = new Map();
  for (const [position, event] of events.entries()) {
    const previous = events[position - 1];
    const eventID =
      typeof event?.eventId === "string" ? event.eventId.trim() : "";
    if (
      event?.schemaVersion !== cassettePolicy.schemaVersion ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence !== position + 1 ||
      !["intent", "effect", "direct-stimulus"].includes(event.kind) ||
      typeof event.type !== "string" ||
      !event.type.trim() ||
      typeof event.eventId !== "string" ||
      !eventID ||
      eventKinds.has(eventID) ||
      typeof event.scopeId !== "string" ||
      !event.scopeId.trim() ||
      !Number.isSafeInteger(event.occurredAtUnixMs) ||
      event.occurredAtUnixMs <= 0 ||
      (previous !== undefined &&
        event.occurredAtUnixMs < previous.occurredAtUnixMs) ||
      (event.payload !== undefined &&
        (typeof event.payload !== "object" ||
          event.payload === null ||
          Array.isArray(event.payload)))
    ) {
      throw new Error(
        `cassette activity event ${event?.sequence ?? "unknown"} is invalid`
      );
    }
    if (
      event.kind === "effect" &&
      (typeof event.causedByEventId !== "string" ||
        eventKinds.get(event.causedByEventId.trim()) !== "intent" ||
        !event.payload ||
        !["succeeded", "failed", "timedOut"].includes(event.payload.outcome))
    ) {
      throw new Error(
        `cassette effect ${event.sequence} does not reference an earlier intent`
      );
    }
    if (event.kind !== "effect" && event.causedByEventId !== undefined) {
      throw new Error(
        `cassette activity event ${event.sequence} has an invalid cause`
      );
    }
    eventKinds.set(eventID, event.kind);
  }
  return events;
}

function stimulusPrompt(payload) {
  if (
    typeof payload?.displayPrompt === "string" &&
    payload.displayPrompt.trim()
  ) {
    return payload.displayPrompt.trim();
  }
  const blocks = payload?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function parseJSONLines(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function validateFixtureRecord(record) {
  if (
    record?.schemaVersion !== 1 ||
    !record.table ||
    !record.values ||
    typeof record.values !== "object"
  ) {
    throw new Error("state fixture record is invalid");
  }
  sqlIdentifier(record.table);
  for (const column of Object.keys(record.values)) sqlIdentifier(column);
}

function sqlIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new Error(`invalid SQLite identifier: ${value}`);
  }
  return `"${value}"`;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite fixture number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${sqlString(value)}'`;
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function normalizeFixtureValues(values, identityMap = new Map()) {
  const normalized = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      key === "id" ||
      key === "version" ||
      key === "message_version" ||
      (key === "seq" &&
        typeof value === "number" &&
        value >= 1_000_000_000_000) ||
      key.endsWith("_at_unix_ms")
    ) {
      continue;
    }
    if (["cwd", "document_path", "normalized_path"].includes(key)) {
      normalized[key] = `<${key}>`;
      continue;
    }
    if (typeof value === "string" && identityMap.has(value)) {
      normalized[key] = identityMap.get(value);
      continue;
    }
    if (
      key === "clientSubmitId" &&
      typeof value === "string" &&
      value.startsWith("plan-decision:") &&
      identityMap.has(value.slice("plan-decision:".length))
    ) {
      normalized[key] =
        "plan-decision:" +
        identityMap.get(value.slice("plan-decision:".length));
      continue;
    }
    if (
      typeof value === "string" &&
      [
        "agent_session_id",
        "root_agent_session_id",
        "parent_agent_session_id",
        "source_session_id"
      ].includes(key)
    ) {
      normalized[key] = identityMap.get(value) ?? value;
      continue;
    }
    if (key.endsWith("_json") && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        normalized[key] = Array.isArray(parsed)
          ? parsed.map((child) =>
              child && typeof child === "object"
                ? normalizeFixtureValues(child, identityMap)
                : child
            )
          : parsed && typeof parsed === "object"
            ? normalizeFixtureValues(parsed, identityMap)
            : parsed;
        continue;
      } catch {
        // A typed JSON column must remain visible if it is malformed.
      }
    }
    if (Array.isArray(value)) {
      normalized[key] = value.map((child) =>
        child && typeof child === "object"
          ? normalizeFixtureValues(child, identityMap)
          : child
      );
    } else if (value && typeof value === "object") {
      normalized[key] = normalizeFixtureValues(value, identityMap);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function normalizeReplayFixtureRecord(
  table,
  values,
  identityMap = new Map()
) {
  const normalized = normalizeFixtureValues(values, identityMap);
  if (table !== "workspace_agent_sessions") {
    return normalized;
  }
  delete normalized.internal_runtime_context_json;
  const metadata = normalized.session_metadata_json;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    delete metadata.capabilities;
    delete metadata.usage;
  }
  return normalized;
}

function stableJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runDesktopAction(input) {
  await mkdir(input.artifactDirectory, { recursive: true });
  if (input.mode === "replay") {
    await writeFile(
      input.controlPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        command: "resume"
      })
    );
  }
  await writeReplayStatus(input.statusPath, {
    phase: "replaying",
    ...(input.mode === "replay"
      ? {
          currentCheckpoint: 0,
          totalCheckpoints: input.checkpoints.length,
          paused: false,
          timingMode: "realtime",
          targetCheckpoint: null
        }
      : {})
  });
  const cdpPort = await reservePort();
  const desktop = startDesktop({
    args: input.desktopLaunch?.args,
    cdpPort,
    command: input.desktopLaunch?.command,
    daemonPath: input.daemonPath,
    desktopLogPath: input.logPath,
    environment:
      input.mode === "replay"
        ? {
            TUTTI_AGENT_CASSETTE_MODE: "replay",
            TUTTI_AGENT_CASSETTE_PATH: join(
              input.cassetteDirectory,
              "provider"
            ),
            ...(input.statusPath
              ? { TUTTI_AGENT_SESSION_REPLAY_STATUS_PATH: input.statusPath }
              : {}),
            ...(input.controlPath
              ? { TUTTI_AGENT_SESSION_REPLAY_CONTROL_PATH: input.controlPath }
              : {})
          }
        : {},
    headless: input.headless,
    stateDirectory: input.runtime.stateDirectory,
    userDataDirectory: input.runtime.userDataDirectory
  });
  const disposeManagedShutdown = input.keepDesktopOpen
    ? bindManagedReplayShutdown(desktop)
    : () => {};
  let pageClient = null;
  let primaryError = null;
  let replayPlayback = null;
  let result = null;
  let replacementRequested = false;
  let surfaceReady = false;
  try {
    const pageWebSocket = await waitForPageWebSocket(
      cdpPort,
      desktop,
      input.timeoutMs
    );
    pageClient = await CdpClient.connect(pageWebSocket);
    await pageClient.send("Runtime.enable");
    await pageClient.send("Page.enable");
    await prepareAgentSessionSurface(pageClient, input.action, input.timeoutMs);
    const reportSurfaceReady = () => {
      if (surfaceReady) return;
      surfaceReady = true;
      input.onSurfaceReady?.();
    };
    if (input.mode === "record") {
      await startSessionRecording(pageClient, input.timeoutMs);
    }
    let settled = null;
    if (input.mode === "replay") {
      if (
        input.action.type === "continue-session" ||
        input.initialTargetCheckpoint === 0
      ) {
        reportSurfaceReady();
      }
      replayPlayback = await replayStimuli(
        input.runtime.stateDirectory,
        input.action,
        input.timeoutMs,
        {
          checkpoints: input.checkpoints,
          controlPath: input.controlPath,
          initialTargetCheckpoint: input.initialTargetCheckpoint,
          onCheckpoint: input.onCheckpoint,
          onReplacement: input.onReplacement,
          rendererDriver: createRendererActivityDriver(
            pageClient,
            input.timeoutMs
          ),
          statusPath: input.statusPath,
          async onStimulusAccepted(stimulus) {
            if (
              input.action.type !== "create-session" ||
              stimulus.type !== "session.create"
            ) {
              return;
            }
            await activateCreatedReplaySessionSurface(
              pageClient,
              input.action,
              input.timeoutMs
            );
            reportSurfaceReady();
          }
        }
      );
      settled = await waitForEvaluation(
        pageClient,
        `(() => {
          const detail = document.querySelector(${JSON.stringify(
            `main[data-agent-session-id="${input.action.agentSessionId}"]`
          )});
          const text = [...document.querySelectorAll('[data-agent-message-speaker="assistant"]')]
            .at(-1)
            ?.querySelector('[data-workspace-agent-markdown="true"]')
            ?.textContent?.trim() ?? '';
          return {
            ready: Boolean(detail) &&
              !document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]'),
            assistantText: text,
            activeSessionId: detail
              ? ${JSON.stringify(input.action.agentSessionId)}
              : null
          };
        })()`,
        input.timeoutMs,
        "replayed Agent Session stimuli",
        100
      );
    }
    for (
      let index = 0;
      input.mode === "record" && index < input.action.prompts.length;
      index += 1
    ) {
      await enterAndSubmitComposerPrompt(
        pageClient,
        input.action.prompts[index],
        input.timeoutMs
      );
      await waitForEvaluation(
        pageClient,
        `({ ready: Boolean(document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]')) })`,
        input.timeoutMs,
        `Agent turn ${index + 1} working state`,
        50
      );
      const expectedToken = input.action.expectedTokens?.[index] ?? "";
      settled = await waitForEvaluation(
        pageClient,
        `(() => {
          const assistants = [...document.querySelectorAll('[data-agent-message-speaker="assistant"]')];
          const assistant = ${JSON.stringify(expectedToken)}
            ? assistants.find((element) => element.textContent?.includes(${JSON.stringify(expectedToken)}))
            : assistants.at(-1);
          const text = assistant
            ?.querySelector('[data-workspace-agent-markdown="true"]')
            ?.textContent?.trim() ?? '';
          return {
            ready: !document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]') &&
              Boolean(text) &&
              (!${JSON.stringify(expectedToken)} || text.includes(${JSON.stringify(expectedToken)})),
            assistantText: text,
            activeSessionId: [...document.querySelectorAll('[data-testid^="agent-gui-conversation-item-"]')]
              .find((row) => row.dataset.active === 'true')
              ?.dataset.testid?.slice('agent-gui-conversation-item-'.length) ?? null
          };
        })()`,
        input.timeoutMs,
        `settled Agent turn ${index + 1}`,
        100
      );
    }
    await captureScreenshot(
      pageClient,
      join(input.artifactDirectory, `${input.mode}-agent-gui.png`)
    );
    if (!settled.activeSessionId) {
      throw new Error("settled Agent turn has no active Session identity");
    }
    let recordingDirectory = null;
    if (input.mode === "record") {
      const completedRecording = await stopSessionRecording(
        pageClient,
        input.runtime.stateDirectory,
        input.action.workspaceId,
        input.timeoutMs
      );
      if (completedRecording) {
        recordingDirectory = completedRecording.directory;
      } else {
        const completedUIRecording = await waitForEvaluation(
          pageClient,
          `(() => {
            const recording = document.querySelector('[data-testid="agent-session-recording"]');
            const directory = recording?.getAttribute('data-recording-directory') ?? '';
            return {
              ready: Boolean(directory) &&
                Boolean(document.querySelector('[data-testid="agent-session-recording-copy"]')),
              directory
            };
          })()`,
          input.timeoutMs,
          "completed UI Agent session recording",
          100
        );
        recordingDirectory = completedUIRecording.directory;
      }
    }
    result = {
      activeSessionId: settled.activeSessionId,
      assistantText: settled.assistantText,
      recordingDirectory
    };
    await writeReplayStatus(input.statusPath, { phase: "verifying" });
    await input.verifyResult?.(result);
    if (input.onSurfaceReady && !surfaceReady) {
      throw new Error("Replay Electron never exposed its target Session");
    }
    await writeReplayStatus(input.statusPath, { phase: "complete" });
    input.onCompleted?.(result);
    if (input.keepDesktopOpen) {
      pageClient.close();
      pageClient = null;
      await replayPlayback.waitForReplacement(
        () => desktop.exitCode === null && desktop.signalCode === null
      );
    }
  } catch (error) {
    if (error instanceof ReplayReplacementRequested) {
      replacementRequested = true;
      return { replaced: true };
    }
    primaryError = error;
    try {
      await writeReplayStatus(input.statusPath, {
        errorMessage: replayStatusErrorMessage(error),
        phase: "failed"
      });
    } catch {
      // Preserve the replay or verification failure as the primary error.
    }
    if (pageClient) {
      try {
        await captureScreenshot(
          pageClient,
          join(input.artifactDirectory, `${input.mode}-failure.png`)
        );
      } catch {
        // The primary error is more useful than a best-effort screenshot error.
      }
    }
    input.onFailed?.(error);
    if (
      input.keepDesktopOpen &&
      surfaceReady &&
      desktop.exitCode === null &&
      desktop.signalCode === null
    ) {
      pageClient?.close();
      pageClient = null;
      try {
        await replayPlayback.waitForReplacement(
          () => desktop.exitCode === null && desktop.signalCode === null
        );
      } catch (replacementError) {
        if (replacementError instanceof ReplayReplacementRequested) {
          replacementRequested = true;
          return { replaced: true };
        }
        throw replacementError;
      }
    }
    throw error;
  } finally {
    disposeManagedShutdown();
    pageClient?.close();
    if (
      !input.keepDesktopOpen ||
      replacementRequested ||
      (primaryError && !surfaceReady)
    ) {
      await stopProcessTree(desktop);
    }
  }
  if (!primaryError && desktop.exitCode && desktop.exitCode !== 0) {
    throw new Error(`Desktop exited with code ${desktop.exitCode}`);
  }
  return result;
}

async function writeReplayStatus(path, status) {
  if (!path) return;
  let previous = {};
  try {
    previous = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ ...previous, ...status }));
  await rename(temporaryPath, path);
}

export function createRendererActivityDriver(client, timeoutMs) {
  const invoke = async (method, event) => {
    const evaluation = await client.send("Runtime.evaluate", {
      expression: `(async () => {
        const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
        let driver = globalThis.__tuttiAgentSessionReplayDriver;
        while (!driver && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          driver = globalThis.__tuttiAgentSessionReplayDriver;
        }
        if (!driver || typeof driver[${JSON.stringify(method)}] !== "function") {
          throw new Error(${JSON.stringify(
            `renderer replay bridge does not implement ${method}`
          )});
        }
        return await driver[${JSON.stringify(method)}](${JSON.stringify(
          event
        )});
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs
    });
    if (evaluation.exceptionDetails) {
      const description =
        evaluation.exceptionDetails.exception?.description ??
        evaluation.exceptionDetails.text;
      throw new Error(
        `renderer replay ${method} failed for ${event.type}: ${description}`
      );
    }
    return evaluation.result?.value;
  };
  return {
    dispatchIntent(event) {
      return invoke("dispatchIntent", event);
    },
    verifyEffect(event) {
      return invoke("verifyEffect", event);
    }
  };
}

function replayStatusErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 12_000);
}

async function verifyReplayTransport(stateDirectory, timeoutMs) {
  const listener = JSON.parse(
    await readFile(join(stateDirectory, "run", "tuttid.listener.json"), "utf8")
  );
  const baseURL = `http://${listener.addr}`;
  const headers = {
    authorization: `Bearer ${listener.auth.token}`
  };
  const deadline = Date.now() + timeoutMs;
  let latestPlayback = null;
  while (Date.now() < deadline) {
    const playbackResponse = await fetch(
      `${baseURL}/v1/agent-session-replay/transport/playback`,
      {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    const playbackBody = await playbackResponse.text();
    if (!playbackResponse.ok) {
      throw new Error(
        `replay transport playback failed with ${playbackResponse.status}: ${playbackBody}`
      );
    }
    latestPlayback = JSON.parse(playbackBody);
    if (latestPlayback.drained === true) {
      break;
    }
    await delay(50);
  }
  if (latestPlayback?.drained !== true) {
    throw new Error(
      `replay transport did not drain before verification: ${JSON.stringify(latestPlayback)}`
    );
  }
  const response = await fetch(
    `${baseURL}/v1/agent-session-replay/transport/verify`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  if (!response.ok) {
    throw new Error(
      `replay transport verification failed with ${response.status}: ${await response.text()}`
    );
  }
}

function bindManagedReplayShutdown(desktop) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void stopProcessTree(desktop);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

export async function replayStimuli(
  stateDirectory,
  action,
  timeoutMs,
  input = {}
) {
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length === 0) {
    throw new Error("replay checkpoints are required");
  }
  const listener = JSON.parse(
    await readFile(join(stateDirectory, "run", "tuttid.listener.json"), "utf8")
  );
  const baseURL = `http://${listener.addr}`;
  const headers = {
    authorization: `Bearer ${listener.auth.token}`,
    "content-type": "application/json"
  };
  const playback = createReplayPlaybackController({
    baseURL,
    checkpoints: input.checkpoints,
    controlPath: input.controlPath,
    headers,
    onCheckpoint: input.onCheckpoint,
    onReplacement: input.onReplacement,
    statusPath: input.statusPath,
    targetCheckpoint: input.initialTargetCheckpoint,
    timeoutMs
  });
  await playback.initialize();
  assertNoDuplicateEngineSends(action.activityEvents);
  for (const event of action.activityEvents) {
    await playback.waitUntilRunnable();
    await playback.waitForRecordedEvent(event.occurredAtUnixMs);
    switch (event.kind) {
      case "intent":
        if (!input.rendererDriver?.dispatchIntent) {
          throw new Error(
            `renderer activity driver is required for intent ${event.type}`
          );
        }
        await playback.runWhilePolling(() =>
          input.rendererDriver.dispatchIntent(event)
        );
        break;
      case "effect":
        if (!input.rendererDriver?.verifyEffect) {
          throw new Error(
            `renderer activity driver is required for effect ${event.type}`
          );
        }
        await playback.runWhilePolling(() =>
          input.rendererDriver.verifyEffect(event)
        );
        break;
      case "direct-stimulus":
        await playback.runWhilePolling(() =>
          replayDirectStimulus({
            baseURL,
            event,
            headers,
            playback,
            timeoutMs
          })
        );
        await input.onStimulusAccepted?.(event);
        break;
      default:
        throw new Error(`unsupported replay activity kind: ${event.kind}`);
    }
    await input.onActivityEventCompleted?.(event);
    const checkpoint = playback.checkpointAfter(event.sequence);
    if (checkpoint) {
      await playback.reach(checkpoint);
    }
  }
  await waitForSessionIdle(
    baseURL,
    headers,
    action.workspaceId,
    action.agentSessionId,
    timeoutMs,
    playback
  );
  await playback.waitUntilRunnable();
  return playback;
}

async function replayDirectStimulus({
  baseURL,
  event,
  headers,
  playback,
  timeoutMs
}) {
  if (replayStimulusPrecondition(event) === "session-idle") {
    await waitForSessionIdle(
      baseURL,
      headers,
      event.workspaceId,
      event.agentSessionId,
      timeoutMs,
      playback
    );
  }
  const request = replayStimulusRequest(event);
  if (!request) {
    throw new Error(`unsupported direct replay stimulus: ${event.type}`);
  }
  const deadline = Date.now() + timeoutMs;
  let response;
  let body = "";
  while (Date.now() < deadline) {
    response = await fetch(`${baseURL}${request.path}`, {
      method: "POST",
      headers,
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) })
    });
    body = await response.text();
    if (response.ok) break;
    if (!replayStimulusRetryableStatus(event.type, response.status)) {
      const transportFailure =
        response.status === 502
          ? await replayTransportFailure(baseURL, headers, timeoutMs)
          : "";
      throw new Error(
        `stimulus ${event.type} failed with ${response.status}: ${body}${transportFailure ? `\n${transportFailure}` : ""}\nrequest: ${JSON.stringify(request.body)}`
      );
    }
    await delay(100);
  }
  if (!response?.ok) {
    throw new Error(
      `stimulus ${event.type} did not become ready: ${response?.status} ${body}`
    );
  }
}

export function assertNoDuplicateEngineSends(activityEvents) {
  const engineCorrelations = new Set(
    activityEvents
      .filter((event) => event.kind === "intent")
      .map((event) => event.correlationId)
      .filter((correlationID) => typeof correlationID === "string")
  );
  const duplicate = activityEvents.find(
    (event) =>
      event.kind === "direct-stimulus" &&
      event.type === "session.send" &&
      typeof event.correlationId === "string" &&
      engineCorrelations.has(event.correlationId)
  );
  if (duplicate) {
    throw new Error(
      `direct session.send duplicates renderer intent correlation ${duplicate.correlationId}`
    );
  }
}

export function parseReplayCheckpoints(contents, activityEvents) {
  const checkpoints = parseJSONLines(contents);
  if (checkpoints.length === 0) {
    throw new Error("cassette checkpoints are empty");
  }
  const sequences = new Set(activityEvents.map((event) => event.sequence));
  for (const [position, checkpoint] of checkpoints.entries()) {
    if (
      checkpoint.schemaVersion !== cassettePolicy.schemaVersion ||
      checkpoint.index !== position
    ) {
      throw new Error(`cassette checkpoint ${position} is invalid`);
    }
    if (position === 0) {
      if (
        checkpoint.kind !== "bootstrap" ||
        checkpoint.afterActivityEventSequence !== 0
      ) {
        throw new Error("cassette checkpoint 0 must be bootstrap");
      }
      continue;
    }
    const previous = checkpoints[position - 1];
    if (
      checkpoint.kind !== "after-activity-event" ||
      !Number.isSafeInteger(checkpoint.afterActivityEventSequence) ||
      checkpoint.afterActivityEventSequence <=
        previous.afterActivityEventSequence ||
      !sequences.has(checkpoint.afterActivityEventSequence)
    ) {
      throw new Error(`cassette checkpoint ${position} has invalid stimulus`);
    }
  }
  const finalSequence = activityEvents.at(-1)?.sequence ?? 0;
  if (
    checkpoints.at(-1).afterActivityEventSequence !== finalSequence ||
    checkpoints.length > 1 + activityEvents.length
  ) {
    throw new Error("cassette final checkpoint does not match final stimulus");
  }
  return checkpoints;
}

export function createReplayPlaybackController(input) {
  const bySequence = new Map(
    input.checkpoints
      .slice(1)
      .map((checkpoint) => [checkpoint.afterActivityEventSequence, checkpoint])
  );
  let currentCheckpoint = 0;
  let lastRevision = 0;
  let paused = false;
  let targetCheckpoint = input.targetCheckpoint ?? null;
  let timingMode = "realtime";

  const updateStatus = () =>
    writeReplayStatus(input.statusPath, {
      currentCheckpoint,
      totalCheckpoints: input.checkpoints.length,
      paused,
      timingMode,
      targetCheckpoint
    });

  const setTransport = async (command) => {
    const response = await fetch(
      `${input.baseURL}/v1/agent-session-replay/transport/playback`,
      {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(input.timeoutMs)
      }
    );
    if (!response.ok) {
      throw new Error(
        `replay playback command failed with ${response.status}: ${await response.text()}`
      );
    }
  };

  const readTransportPlayback = async () => {
    const response = await fetch(
      `${input.baseURL}/v1/agent-session-replay/transport/playback`,
      {
        headers: input.headers,
        signal: AbortSignal.timeout(input.timeoutMs)
      }
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `replay playback state failed with ${response.status}: ${body}`
      );
    }
    const state = JSON.parse(body);
    if (
      typeof state.paused !== "boolean" ||
      !Number.isFinite(state.playbackElapsedMs) ||
      state.playbackElapsedMs < 0 ||
      !Number.isFinite(state.speed) ||
      state.speed <= 0 ||
      !["realtime", "fast-forward"].includes(state.timingMode)
    ) {
      throw new Error("replay playback state is invalid");
    }
    return state;
  };

  const setRealtime = async () => {
    if (timingMode === "realtime") return;
    await setTransport({
      command: "set-timing-mode",
      timingMode: "realtime"
    });
    timingMode = "realtime";
  };

  const applyControl = async () => {
    if (!input.controlPath) return;
    let control;
    try {
      control = JSON.parse(await readFile(input.controlPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(
        `replay control is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (control.revision === lastRevision) return;
    if (
      control.schemaVersion !== 1 ||
      !Number.isSafeInteger(control.revision) ||
      control.revision <= lastRevision
    ) {
      throw new Error("replay control revision is invalid");
    }
    switch (control.command) {
      case "pause":
        await setTransport({ command: "pause" });
        paused = true;
        targetCheckpoint = null;
        break;
      case "resume":
        await setRealtime();
        await setTransport({ command: "resume" });
        paused = false;
        targetCheckpoint = null;
        break;
      case "next-checkpoint":
        targetCheckpoint = Math.min(
          currentCheckpoint + 1,
          input.checkpoints.length - 1
        );
        if (targetCheckpoint > currentCheckpoint) {
          await setTransport({
            command: "set-timing-mode",
            timingMode: "fast-forward"
          });
          timingMode = "fast-forward";
          await setTransport({ command: "resume" });
          paused = false;
        }
        break;
      case "previous-checkpoint":
      case "restart":
      case "switch-cassette":
        paused = true;
        lastRevision = control.revision;
        await updateStatus();
        await input.onReplacement?.({
          command: control.command,
          currentCheckpoint,
          ...(control.command === "switch-cassette"
            ? { cassetteId: control.cassetteId }
            : {})
        });
        throw new ReplayReplacementRequested();
      default:
        throw new Error(
          `unsupported replay control command: ${control.command}`
        );
    }
    lastRevision = control.revision;
    await updateStatus();
  };

  const activityClock = createReplayActivityClock({
    playbackState: async () => {
      await applyControl();
      return readTransportPlayback();
    }
  });

  return {
    checkpointAfter(sequence) {
      return bySequence.get(sequence) ?? null;
    },
    async initialize() {
      if (
        targetCheckpoint !== null &&
        (!Number.isSafeInteger(targetCheckpoint) ||
          targetCheckpoint < 0 ||
          targetCheckpoint >= input.checkpoints.length)
      ) {
        throw new Error(
          `replay target checkpoint is invalid: ${targetCheckpoint}`
        );
      }
      if (targetCheckpoint === 0) {
        await setTransport({ command: "pause" });
        paused = true;
        targetCheckpoint = null;
      } else if (targetCheckpoint !== null) {
        await setTransport({
          command: "set-timing-mode",
          timingMode: "fast-forward"
        });
        timingMode = "fast-forward";
        await setTransport({ command: "resume" });
      }
      await updateStatus();
    },
    async reach(checkpoint) {
      currentCheckpoint = checkpoint.index;
      if (targetCheckpoint !== null && currentCheckpoint >= targetCheckpoint) {
        await setRealtime();
        await setTransport({ command: "pause" });
        paused = true;
        targetCheckpoint = null;
      }
      await updateStatus();
      await input.onCheckpoint?.(currentCheckpoint);
    },
    async waitUntilRunnable() {
      while (true) {
        await activityClock.synchronize();
        if (!paused) return;
        await delay(50);
      }
    },
    waitForRecordedEvent(occurredAtUnixMs) {
      return activityClock.waitUntil(occurredAtUnixMs);
    },
    async runWhilePolling(operation) {
      let settled = false;
      const result = Promise.resolve()
        .then(operation)
        .finally(() => {
          settled = true;
        });
      while (!settled) {
        await Promise.race([result.catch(() => undefined), delay(50)]);
        if (!settled) await applyControl();
      }
      return result;
    },
    async waitForReplacement(isSurfaceOpen) {
      while (isSurfaceOpen()) {
        await applyControl();
        await delay(50);
      }
    }
  };
}

export function createReplayActivityClock(input) {
  const wait = input.wait ?? delay;
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  let originOccurredAtUnixMs = null;
  let originPlaybackElapsedMs = null;
  let lastTargetOccurredAtUnixMs = null;
  let skippedElapsedMs = 0;

  const synchronize = () => input.playbackState();

  return {
    synchronize,
    async waitUntil(occurredAtUnixMs) {
      if (
        !Number.isSafeInteger(occurredAtUnixMs) ||
        occurredAtUnixMs <= 0 ||
        (lastTargetOccurredAtUnixMs !== null &&
          occurredAtUnixMs < lastTargetOccurredAtUnixMs)
      ) {
        throw new Error(`replay activity time is invalid: ${occurredAtUnixMs}`);
      }
      if (originOccurredAtUnixMs === null) {
        originOccurredAtUnixMs = occurredAtUnixMs;
        lastTargetOccurredAtUnixMs = occurredAtUnixMs;
        const playback = await synchronize();
        originPlaybackElapsedMs = playback.playbackElapsedMs;
        return;
      }
      lastTargetOccurredAtUnixMs = occurredAtUnixMs;
      const targetElapsedMs = occurredAtUnixMs - originOccurredAtUnixMs;
      while (true) {
        const playback = await synchronize();
        const playbackElapsedMs =
          playback.playbackElapsedMs -
          originPlaybackElapsedMs +
          skippedElapsedMs;
        if (playback.timingMode === "fast-forward") {
          skippedElapsedMs += Math.max(0, targetElapsedMs - playbackElapsedMs);
          return;
        }
        const remainingMs = targetElapsedMs - playbackElapsedMs;
        if (remainingMs <= 0 && !playback.paused) {
          return;
        }
        await wait(
          playback.paused
            ? pollIntervalMs
            : Math.max(
                1,
                Math.min(
                  pollIntervalMs,
                  Math.ceil(remainingMs / playback.speed)
                )
              )
        );
      }
    }
  };
}

class ReplayReplacementRequested extends Error {
  constructor() {
    super("Replay Run replacement requested");
  }
}

export function replayStimulusPrecondition(stimulus) {
  return stimulus.type === "session.send" &&
    stimulus.payload?.guidance !== true &&
    stimulus.payload?.guidance !== "steer"
    ? "session-idle"
    : null;
}

export function replayStimulusRetryableStatus(type, status) {
  switch (type) {
    case "session.send":
    case "goal.control":
    case "session.settings.update":
      return status === 409;
    case "turn.cancel":
    case "interactive.response":
    case "plan.decision":
      return status === 404 || status === 409;
    default:
      return false;
  }
}

async function replayTransportFailure(baseURL, headers, timeoutMs) {
  try {
    const response = await fetch(
      `${baseURL}/v1/agent-session-replay/transport/verify`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    if (response.ok) return "";
    return `replay transport mismatch: ${await response.text()}`;
  } catch (error) {
    return `replay transport verification failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function replayStimulusRequest(stimulus) {
  const workspace = encodeURIComponent(stimulus.workspaceId);
  const session = encodeURIComponent(stimulus.agentSessionId);
  const base = `/v1/workspaces/${workspace}/agent-sessions`;
  switch (stimulus.type) {
    case "session.create": {
      const { content, displayPrompt, ...payload } = stimulus.payload;
      return {
        path: base,
        body: {
          ...payload,
          agentSessionId: stimulus.agentSessionId,
          initialContent: content,
          initialDisplayPrompt: displayPrompt
        }
      };
    }
    case "session.send":
      return {
        path: `${base}/${session}/input`,
        body: stimulus.payload
      };
    case "turn.cancel":
      return {
        path: `${base}/${session}/turns/${encodeURIComponent(stimulus.payload.turnId)}/cancel`
      };
    case "interactive.response":
      return {
        path: `${base}/${session}/interactives/${encodeURIComponent(stimulus.payload.requestId)}/response`,
        body: {
          turnId: stimulus.payload.turnId,
          action: stimulus.payload.action,
          optionId: stimulus.payload.optionId,
          payload: stimulus.payload.payload
        }
      };
    case "plan.decision":
      return {
        path: `${base}/${session}/turns/${encodeURIComponent(stimulus.payload.turnId)}/plan-decisions/${encodeURIComponent(stimulus.payload.requestId)}`,
        body: {
          promptKind: stimulus.payload.promptKind,
          action: stimulus.payload.action,
          idempotencyKey: stimulus.payload.idempotencyKey
        }
      };
    case "goal.control":
      return {
        path: `${base}/${session}/goal`,
        body: {
          action: stimulus.payload.action,
          objective: stimulus.payload.objective
        }
      };
    case "session.settings.update":
      return {
        path: `${base}/${session}/settings`,
        body: stimulus.payload.settings
      };
    default:
      return null;
  }
}

async function waitForSessionIdle(
  baseURL,
  headers,
  workspaceId,
  agentSessionId,
  timeoutMs,
  playback
) {
  let remainingMs = timeoutMs;
  let latest = null;
  while (remainingMs > 0) {
    await playback?.waitUntilRunnable();
    const pollStartedAt = Date.now();
    const response = await fetch(
      `${baseURL}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(agentSessionId)}`,
      { headers }
    );
    if (response.ok) {
      latest = await response.json();
      const session = latest.session ?? latest;
      if (
        !session.activeTurnId &&
        !["working", "waiting"].includes(session.status)
      ) {
        return session;
      }
    }
    await delay(100);
    remainingMs -= Date.now() - pollStartedAt;
  }
  throw new Error(
    `timed out waiting for replay Session ${agentSessionId} to become idle: ${JSON.stringify(latest)}`
  );
}

async function startSessionRecording(client, timeoutMs) {
  const focused = await client.send("Runtime.evaluate", {
    expression: `(() => {
      if (
        document.querySelector('[data-testid="agent-session-recording-start"]') ||
        document.querySelector('[data-testid="agent-session-recording-stop"]')
      ) {
        return false;
      }
      const dock = document.querySelector(
        '[data-desktop-dock-anchor-key="agent-gui:unified"] button'
      );
      if (!(dock instanceof HTMLButtonElement)) {
        throw new Error('AgentGUI dock launcher is unavailable');
      }
      dock.click();
      return true;
    })()`,
    returnByValue: true
  });
  if (focused.result.value === true) {
    await delay(100);
  }
  await waitForEvaluation(
    client,
    `(() => {
      if (document.querySelector('[data-testid="agent-session-recording-stop"]')) {
        return { ready: true };
      }
      const button = document.querySelector('[data-testid="agent-session-recording-start"]');
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        return { ready: false };
      }
      button.click();
      return { ready: false };
    })()`,
    timeoutMs,
    "ready UI Agent session recording",
    100
  );
}

async function stopSessionRecording(
  client,
  stateDirectory,
  workspaceId,
  timeoutMs
) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const button = document.querySelector('[data-testid="agent-session-recording-stop"]');
      if (!(button instanceof HTMLButtonElement) || button.disabled) {
        return false;
      }
      button.click();
      return true;
    })()`,
    returnByValue: true
  });
  if (result.result.value === true) {
    return null;
  }

  const listener = JSON.parse(
    await readFile(join(stateDirectory, "run", "tuttid.listener.json"), "utf8")
  );
  const headers = {
    authorization: `Bearer ${listener.auth.token}`,
    "content-type": "application/json"
  };
  const listResponse = await fetch(
    `http://${listener.addr}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-session-recordings`,
    {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const listBody = await listResponse.text();
  if (!listResponse.ok) {
    throw new Error(
      `list Agent Session recordings failed with ${listResponse.status}: ${listBody}`
    );
  }
  const active = JSON.parse(listBody).recordings.filter((recording) =>
    ["preparing", "ready", "recording"].includes(recording.status)
  );
  if (active.length !== 1) {
    throw new Error(
      `expected one active Agent Session recording, found ${active.length}`
    );
  }
  const response = await fetch(
    `http://${listener.addr}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-session-recordings/${encodeURIComponent(active[0].id)}/complete`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `complete Agent Session recording failed with ${response.status}: ${body}`
    );
  }
  return JSON.parse(body);
}

async function prepareAgentSessionSurface(client, action, timeoutMs) {
  await prepareAgentSessionTarget(client, action, timeoutMs);
  if (action.type === "continue-session") {
    await activateExistingReplaySessionSurface(client, action, timeoutMs);
  }
  await waitForEvaluation(
    client,
    `(() => {
      const editor = document.querySelector('#agent-gui-detail [contenteditable="true"][role="textbox"]');
      const stop = document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]');
      return { ready: editor instanceof HTMLElement && !stop };
    })()`,
    timeoutMs,
    "idle Agent composer"
  );
}

async function prepareAgentSessionTarget(client, action, timeoutMs) {
  await waitForEvaluation(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(action.agentTargetId)});
      const dock = document.querySelector(
        '[data-desktop-dock-anchor-key="agent-gui:unified"] button'
      );
      return { ready: Boolean(target) || dock instanceof HTMLButtonElement };
    })()`,
    timeoutMs,
    "AgentGUI surface or dock launcher"
  );
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const target = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(action.agentTargetId)});
      if (target) return false;
      const dock = document.querySelector(
        '[data-desktop-dock-anchor-key="agent-gui:unified"] button'
      );
      if (!(dock instanceof HTMLButtonElement)) {
        throw new Error('AgentGUI dock launcher is unavailable');
      }
      dock.click();
      return true;
    })()`,
    returnByValue: true
  });
  await waitForEvaluation(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(action.agentTargetId)});
      return {
        ready: target instanceof HTMLButtonElement &&
          !target.disabled &&
          target.dataset.disabled !== 'true'
      };
    })()`,
    timeoutMs,
    `enabled Agent target ${action.agentTargetId}`
  );
  await selectProvider(client, action.agentTargetId, timeoutMs);
}

async function activateExistingReplaySessionSurface(client, action, timeoutMs) {
  await ensureReplayConversationRailExpanded(client, timeoutMs);
  await waitForEvaluation(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-testid="agent-gui-conversation-item-${action.agentSessionId}"]`)});
      return { ready: Boolean(row) };
    })()`,
    timeoutMs,
    `Agent session ${action.agentSessionId}`
  );
  await selectSession(
    client,
    action.agentSessionId,
    action.agentTargetId,
    timeoutMs
  );
  await waitForEvaluation(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-testid="agent-gui-conversation-item-${action.agentSessionId}"]`)});
      return { ready: row?.dataset.active === 'true' };
    })()`,
    timeoutMs,
    `active Agent session ${action.agentSessionId}`
  );
}

async function activateCreatedReplaySessionSurface(client, action, timeoutMs) {
  await client.send("Page.reload");
  await prepareAgentSessionTarget(client, action, timeoutMs);
  await activateExistingReplaySessionSurface(client, action, timeoutMs);
}

async function ensureReplayConversationRailExpanded(client, timeoutMs) {
  await waitForEvaluation(
    client,
    `(() => {
      const toggle = document.querySelector('[data-testid="agent-gui-toggle-conversation-rail"]');
      if (!(toggle instanceof HTMLButtonElement)) {
        return { ready: false, reason: 'toggle-unavailable' };
      }
      const collapsed =
        toggle.dataset.agentGuiConversationRailCollapsed === 'true' ||
        document.querySelector('[data-agent-gui-workbench-header]')?.dataset
          .agentGuiWorkbenchHeaderCollapsed === 'true';
      if (collapsed) {
        toggle.click();
        return { ready: false, reason: 'expanding' };
      }
      return { ready: true };
    })()`,
    timeoutMs,
    "expanded Agent conversation rail",
    100
  );
}

async function enableAgentSessionRecordingFeature(databasePath) {
  await runCommand("sqlite3", [
    databasePath,
    `
UPDATE desktop_preferences
SET feature_flags_json = json_set(
  COALESCE(NULLIF(feature_flags_json, ''), '{}'),
  '$."agent.sessionRecording"',
  json('true')
)
WHERE id = 'desktop';
`
  ]);
}

async function captureScreenshot(client, outputPath) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  if (!result.data) {
    throw new Error("CDP screenshot returned no data");
  }
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function waitForCompleteManifest(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      latest = JSON.parse(await readFile(path, "utf8"));
      if (latest.status === "complete") {
        return latest;
      }
    } catch {
      latest = null;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for complete cassette manifest: ${JSON.stringify(latest)}`
  );
}

async function ensureEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) {
    throw new Error(`record cassette directory must be empty: ${directory}`);
  }
}

async function removeRuntime(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200
  });
}

function sqliteJSON(databasePath, sql) {
  return runCommand("sqlite3", ["-json", databasePath, sql]).then((output) =>
    output.trim() ? JSON.parse(output) : []
  );
}

function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
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

export function validateAction(action) {
  if (
    action?.schemaVersion !== 1 ||
    !["create-session", "continue-session"].includes(action.type) ||
    !action.agentTargetId ||
    !Array.isArray(action.prompts) ||
    action.prompts.length === 0 ||
    action.prompts.some((prompt) => !String(prompt).trim())
  ) {
    throw new Error("cassette action is invalid or unsupported");
  }
}

export function parseArgs(argv) {
  const options = {
    timeoutMs: defaultTimeoutMs
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--record") {
      setMode(options, "record", requiredValue(argv, (index += 1), arg));
    } else if (arg === "--replay") {
      setMode(options, "replay", requiredValue(argv, (index += 1), arg));
    } else if (arg === "--prompt") {
      options.prompt = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--expected-token") {
      options.expectedToken = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveNumber(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--headless") {
      options.headless = true;
    } else if (arg === "--managed") {
      options.managed = true;
    } else if (arg === "--run-id") {
      options.runId = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--target-checkpoint") {
      options.targetCheckpoint = nonNegativeInteger(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--keep-runtime") {
      options.keepRuntime = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.help && !options.mode) {
    throw new Error("choose exactly one of --record or --replay");
  }
  if (options.managed && options.mode !== "replay") {
    throw new Error("--managed is only supported with --replay");
  }
  if (options.managed && !options.runId) {
    throw new Error("--run-id is required with --managed");
  }
  return options;
}

function setMode(options, mode, directory) {
  if (options.mode) {
    throw new Error("choose exactly one of --record or --replay");
  }
  options.mode = mode;
  options.cassetteDirectory = resolve(directory);
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

function nonNegativeInteger(value, option) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return number;
}

function isMainModule() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

function log(message) {
  process.stderr.write(`[agent-session-replay] ${message}\n`);
}

function printUsage() {
  process.stdout.write(
    `Record and replay an AgentGUI Codex SessionGraph scenario.\n\n` +
      `Usage:\n` +
      `  pnpm e2e:agent-gui -- --record .tmp/cassettes/codex-three-turns\n` +
      `  pnpm e2e:agent-gui -- --replay .tmp/cassettes/codex-three-turns\n\n` +
      `Options:\n` +
      `  --record <directory>   Record a three-Turn scenario into a new empty cassette directory\n` +
      `  --replay <directory>   Replay an existing complete cassette\n` +
      `  --prompt <text>        Record one prompt instead of the default three-Turn scenario\n` +
      `  --expected-token <s>   Text required in the final assistant response\n` +
      `  --timeout-ms <n>       Desktop/action timeout. Default: ${defaultTimeoutMs}\n` +
      `  --headless             Render without showing the Electron window\n` +
      `  --managed              Keep a directly launched replay Electron open until the user closes it\n` +
      `  --run-id <id>          Stable managed Replay Run identity\n` +
      `  --target-checkpoint <n> Fast-forward a replacement Run and pause at checkpoint n\n` +
      `  --keep-runtime         Keep the isolated state and Electron userData\n`
  );
}
