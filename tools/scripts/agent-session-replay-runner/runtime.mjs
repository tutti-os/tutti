import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildDaemon, stopProcessTree } from "../run-agent-gui-performance.mjs";

const hostAccountAuthEnvironment =
  "TUTTI_AGENT_SESSION_REPLAY_HOST_ACCOUNT_AUTH";
const skipHostAccountAuthEnvironment =
  "TUTTI_AGENT_SESSION_REPLAY_SKIP_HOST_ACCOUNT_AUTH";

export const replayListenerInfoPath = (stateDirectory) =>
  join(stateDirectory, "run", "tuttid.listener.json");

const timingPrefix = "[tutti-agent-session-replay-timing] ";

export function logTiming(phase, durationMs, detail = undefined) {
  const payload = {
    detail: detail ?? null,
    durationMs: Math.max(0, Math.round(durationMs)),
    phase,
    source: "tutti",
    startedAt: new Date(
      Date.now() - Math.max(0, Math.round(durationMs))
    ).toISOString()
  };
  process.stderr.write(`${timingPrefix}${JSON.stringify(payload)}\n`);
}

export async function measureTiming(phase, run, detail = undefined) {
  const started = performance.now();
  try {
    return await run();
  } finally {
    logTiming(phase, performance.now() - started, detail);
  }
}

export async function createRuntime(workspaceRoot, mode) {
  return measureTiming(
    "create-runtime",
    async () => {
      const runtimeParent =
        process.env.TUTTI_AGENT_SESSION_REPLAY_RUNTIME_PARENT?.trim() ||
        join(workspaceRoot, ".tmp");
      await mkdir(runtimeParent, { recursive: true });
      const directory = await mkdtemp(
        join(runtimeParent, `agent-session-${mode}-`)
      );
      const stateDirectory = join(directory, "state");
      const userDataDirectory = join(directory, "electron-user-data");
      const daemonPath = join(directory, "tuttid");
      await mkdir(stateDirectory, { recursive: true });
      const preparedDaemonPath =
        process.env.TUTTI_AGENT_SESSION_REPLAY_DAEMON_EXECUTABLE?.trim();
      if (preparedDaemonPath) {
        await access(preparedDaemonPath);
        logTiming("create-runtime.reuse-prepared-daemon", 0, {
          daemonPath: preparedDaemonPath,
          mode
        });
      } else {
        await measureTiming("create-runtime.generate-builtin-apps", () =>
          runCommand("pnpm", ["generate:builtin-apps"], workspaceRoot)
        );
        await measureTiming("create-runtime.build-daemon", () =>
          buildDaemon(daemonPath)
        );
      }
      return {
        daemonPath: preparedDaemonPath || daemonPath,
        directory,
        stateDirectory,
        userDataDirectory
      };
    },
    { mode }
  );
}

export function managedDesktopLaunch() {
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

export function preparedDesktopLaunch() {
  const command =
    process.env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE?.trim();
  if (!command) return undefined;
  const entry = process.env.TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY?.trim();
  if (!entry) {
    throw new Error("prepared replay Electron entry is unavailable");
  }
  return { args: [entry], command };
}

export async function initializeCleanDatabase(
  workspaceRoot,
  runtime,
  workspaceId,
  { seedWorkspace = true } = {}
) {
  return measureTiming(
    "initialize-clean-database",
    async () => {
      const databasePath = join(runtime.stateDirectory, "tuttid.db");
      const templatePath = await ensureMigratedDatabaseTemplate(
        workspaceRoot,
        runtime.daemonPath
      );
      await measureTiming("initialize-clean-database.copy-template", () =>
        cp(templatePath, databasePath)
      );
      await measureTiming(
        "initialize-clean-database.seed",
        () =>
          seedCleanDatabase(
            workspaceRoot,
            databasePath,
            workspaceId,
            seedWorkspace
          ),
        { seedWorkspace }
      );
      // Isolated runtimes start without Tutti account session; reuse the local
      // desktop login when present so connector-market / host-auth paths work.
      const hostAccountStarted = performance.now();
      const hostAccount = await seedHostAccountSession(runtime.stateDirectory);
      logTiming(
        "initialize-clean-database.seed-host-account",
        performance.now() - hostAccountStarted,
        hostAccount
      );
    },
    { seedWorkspace, workspaceId }
  );
}

/**
 * Copy the developer machine Tutti account session into an isolated replay
 * state dir when available. Missing/invalid host auth is a soft skip so CI
 * and machines without a login still boot.
 */
export async function seedHostAccountSession(
  stateDirectory,
  { env = process.env, homeDirectory = homedir() } = {}
) {
  if (isTruthyEnv(env[skipHostAccountAuthEnvironment])) {
    return { action: "skipped-disabled" };
  }

  const sourcePath = resolveHostAccountAuthPath(env, homeDirectory);
  let raw;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { action: "skipped-missing", sourcePath };
    }
    throw error;
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return { action: "skipped-invalid", sourcePath };
  }
  if (
    typeof session?.session_id !== "string" ||
    !session.session_id.trim() ||
    typeof session?.cookie !== "string" ||
    !session.cookie.trim()
  ) {
    return { action: "skipped-invalid", sourcePath };
  }

  const accountDirectory = join(stateDirectory, "account");
  const destinationPath = join(accountDirectory, "auth.json");
  await mkdir(accountDirectory, { recursive: true });
  await writeFile(destinationPath, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600
  });
  return { action: "copied", sourcePath, destinationPath };
}

export function resolveHostAccountAuthPath(
  env = process.env,
  homeDirectory = homedir()
) {
  const override = env[hostAccountAuthEnvironment]?.trim();
  if (override) {
    return override;
  }
  // Replay Desktop always sets TUTTI_ENV=development, whose DefaultStateDir is
  // ~/.tutti-dev — mirror that when picking the host session to reuse.
  return join(homeDirectory, ".tutti-dev", "account", "auth.json");
}

function isTruthyEnv(value) {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

async function ensureMigratedDatabaseTemplate(workspaceRoot, daemonPath) {
  const daemonStat = await stat(daemonPath);
  // Prepared daemon binaries can change mtime when first executed (or when a
  // dirty warmup slot is rewritten). Prefer an explicit stamp / path+size so
  // consecutive ui-drive cases reuse the migrated template.
  const preparedStamp =
    process.env.TUTTI_AGENT_SESSION_REPLAY_DB_TEMPLATE_STAMP?.trim();
  const stampHasher = createHash("sha1")
    .update(daemonPath)
    .update(String(daemonStat.size));
  if (preparedStamp) {
    stampHasher.update(preparedStamp);
  } else if (
    !process.env.TUTTI_AGENT_SESSION_REPLAY_DAEMON_EXECUTABLE?.trim()
  ) {
    stampHasher.update(String(Math.trunc(daemonStat.mtimeMs)));
  }
  const stamp = stampHasher.digest("hex").slice(0, 16);
  const templateRoot =
    process.env.TUTTI_AGENT_SESSION_REPLAY_DB_TEMPLATE_ROOT?.trim() ||
    join(workspaceRoot, ".tmp", "agent-session-replay-db-templates");
  const templateDirectory = join(templateRoot, stamp);
  const templatePath = join(templateDirectory, "tuttid.db");
  try {
    await access(templatePath);
    logTiming("initialize-clean-database.reuse-template", 0, {
      stamp,
      templatePath
    });
    return templatePath;
  } catch {
    // build below
  }

  await mkdir(templateRoot, { recursive: true });
  let ownsBuild = false;
  try {
    await mkdir(templateDirectory);
    ownsBuild = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await waitForDatabaseTemplate(templatePath);
    logTiming("initialize-clean-database.reuse-template", 0, {
      stamp,
      templatePath,
      waited: true
    });
    return templatePath;
  }

  return measureTiming(
    "initialize-clean-database.build-template",
    async () => {
      const stagingParent = join(templateRoot, ".staging");
      await mkdir(stagingParent, { recursive: true });
      const stagingDirectory = await mkdtemp(
        join(stagingParent, `migrate-${stamp}-`)
      );
      const stagingStateDirectory = join(stagingDirectory, "state");
      await mkdir(stagingStateDirectory, { recursive: true });
      try {
        await migrateEmptyDatabase(
          workspaceRoot,
          daemonPath,
          stagingStateDirectory
        );
        const stagingDb = join(stagingStateDirectory, "tuttid.db");
        await access(stagingDb);
        await cp(stagingDb, templatePath);
      } catch (error) {
        if (ownsBuild) {
          await rm(templateDirectory, {
            force: true,
            recursive: true,
            maxRetries: 10,
            retryDelay: 200
          });
        }
        throw error;
      } finally {
        await rm(stagingDirectory, {
          force: true,
          recursive: true,
          maxRetries: 10,
          retryDelay: 200
        });
      }
      return templatePath;
    },
    { stamp }
  );
}

async function waitForDatabaseTemplate(templatePath, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(templatePath);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(
    `timed out waiting for migrated database template: ${templatePath}`
  );
}

async function migrateEmptyDatabase(workspaceRoot, daemonPath, stateDirectory) {
  const listenerInfoPath = replayListenerInfoPath(stateDirectory);
  const daemon = spawn(daemonPath, [], {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      TUTTI_ANALYTICS_DISABLED: "1",
      TUTTI_ENV: "development",
      TUTTI_STATE_DIR: stateDirectory,
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
}

async function seedCleanDatabase(
  workspaceRoot,
  databasePath,
  workspaceId,
  seedWorkspace
) {
  const now = Date.now();
  const workbenchSnapshot = replayWorkbenchSnapshot(
    new Date(now).toISOString()
  );
  await runCommand(
    "sqlite3",
    [
      databasePath,
      `
PRAGMA foreign_keys = ON;
${
  seedWorkspace
    ? `INSERT INTO workspaces (
  id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms
) VALUES (
  '${sqlString(workspaceId)}', 'Replay Scenario', ${now}, ${now}, ${now}
);`
    : ""
}
INSERT INTO desktop_preferences (
  id, locale, theme_source, updated_at_unix_ms
) VALUES (
  'desktop', 'en', 'system', ${now}
)
ON CONFLICT(id) DO NOTHING;
${
  seedWorkspace
    ? `INSERT INTO workspace_workbench_snapshots (
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
);`
    : ""
}
`
    ],
    workspaceRoot
  );
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

export async function enableAgentSessionRecordingFeature(
  databasePath,
  workspaceRoot
) {
  await runCommand(
    "sqlite3",
    [
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
    ],
    workspaceRoot
  );
}

export async function enableAgentSessionRecordingTarget(
  databasePath,
  agentTargetId,
  workspaceRoot
) {
  await runCommand(
    "sqlite3",
    [
      databasePath,
      `
UPDATE agent_targets
SET enabled = 1, updated_at_ms = ${Date.now()}
WHERE id = '${sqlString(agentTargetId)}';
`
    ],
    workspaceRoot
  );
}

export async function setAgentComposerDefaults(
  databasePath,
  agentTargetId,
  { model, permissionModeId, reasoningEffort, speed },
  workspaceRoot
) {
  await runCommand(
    "sqlite3",
    [
      databasePath,
      `
UPDATE desktop_preferences
SET agent_composer_defaults_by_agent_target_json = json_set(
  COALESCE(NULLIF(agent_composer_defaults_by_agent_target_json, ''), '{}'),
  '$."${sqlString(agentTargetId)}".permissionModeId',
  '${sqlString(permissionModeId)}',
  '$."${sqlString(agentTargetId)}".model',
  '${sqlString(model)}',
  '$."${sqlString(agentTargetId)}".reasoningEffort',
  '${sqlString(reasoningEffort)}',
  '$."${sqlString(agentTargetId)}".speed',
  '${sqlString(speed)}'
)
WHERE id = 'desktop';
`
    ],
    workspaceRoot
  );
}

export async function removeRuntime(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200
  });
}

async function runCommand(command, args, workspaceRoot) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`
        )
      );
    });
  });
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}
