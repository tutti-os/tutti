#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CdpClient } from "./capture-electron-trace.mjs";
import {
  clickSession,
  configureWaitDiagnostics,
  evaluate,
  selectProvider,
  selectSession,
  waitForActiveSession,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";
import {
  reservePort,
  startDesktop,
  stopProcessTree,
  waitForPageWebSocket
} from "./run-agent-gui-performance.mjs";
import {
  cassettePolicy,
  materializeReplayWorkspaceBlobs,
  parseActivityEvents,
  portableReplayCWDToken,
  replayActionFromManifest,
  verifyCassette
} from "./agent-session-replay-runner/cassette.mjs";
import {
  createRuntime,
  enableAgentSessionRecordingFeature,
  enableAgentSessionRecordingTarget,
  initializeCleanDatabase,
  managedDesktopLaunch,
  measureTiming,
  preparedDesktopLaunch,
  removeRuntime,
  replayListenerInfoPath,
  setAgentComposerDefaults
} from "./agent-session-replay-runner/runtime.mjs";
import {
  assertForbiddenPathAbsent,
  resolveAgentSessionReplayProjectRoot,
  resolveRecordScenarioProject,
  seedRecordingUserProject,
  verifyRecordedProjectBindingArtifacts
} from "./agent-session-replay-runner/recording.mjs";
import { bindManagedReplayShutdown } from "./agent-session-replay-runner/desktop-shutdown.mjs";
import { uiDriveScenario } from "./agent-session-replay-runner/ui-drive.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..", "..");
/** Agent user-project root; equals Tutti checkout unless PROJECT_ROOT env is set. */
const projectRoot = resolveAgentSessionReplayProjectRoot(workspaceRoot);
const defaultTimeoutMs = 180_000;
const defaultStallTimeoutMs = 60_000;
export const managedReplayReadyPrefix = "[tutti-agent-session-replay-ready] ";
export const managedReplayCompletePrefix =
  "[tutti-agent-session-replay-complete] ";
export const managedReplayFailedPrefix = "[tutti-agent-session-replay-failed] ";
export const managedReplayCheckpointPrefix =
  "[tutti-agent-session-replay-checkpoint] ";
export const managedReplayReplacePrefix =
  "[tutti-agent-session-replay-replace] ";
export function replayControlRouter(
  cassetteId,
  revision,
  command,
  fields = {}
) {
  return {
    schemaVersion: 2,
    cassettes: {
      [cassetteId]: {
        command,
        revision,
        ...fields
      }
    }
  };
}
const activityEventsName = cassettePolicy.files.activityEvents.path;
const checkpointPlanName = cassettePolicy.files.checkpointPlan.path;
const initialStateName = cassettePolicy.files.initialState.path;
const providerManifestName = cassettePolicy.files.providerManifest.path;
const expectedStateName = cassettePolicy.files.expectedState.path;
const blobManifestName = cassettePolicy.files.blobManifest.path;
const cassetteManifestName = cassettePolicy.files.cassetteManifest.path;
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
  configureWaitDiagnostics({
    log,
    stallTimeoutMs: options.stallTimeoutMs
  });
  if (options.mode === "record") {
    await recordCassette(options);
  } else if (options.mode === "replay-workspace") {
    await replayWorkspace(options);
  } else if (options.mode === "ui-drive") {
    await uiDriveScenario({
      ...options,
      artifactDirectory: options.cassetteDirectory,
      workspaceRoot
    });
  } else {
    await replayCassette(options);
  }
}

async function recordCassette(options) {
  return measureTiming(
    "record-cassette",
    async () => {
      await ensureEmptyDirectory(options.cassetteDirectory);
      const runtime = await createRuntime(workspaceRoot, "record");
      const databasePath = join(runtime.stateDirectory, "tuttid.db");
      const scenarioFixturePaths = [];
      let succeeded = false;
      try {
        const workspaceId = "11111111-1111-4111-8111-111111111111";
        const agentTargetId = options.agentTargetId ?? "local:codex";
        const recordScenario = await loadRecordScenario(options);
        await initializeCleanDatabase(workspaceRoot, runtime, workspaceId);
        await enableAgentSessionRecordingFeature(databasePath, workspaceRoot);
        await enableAgentSessionRecordingTarget(
          databasePath,
          agentTargetId,
          workspaceRoot
        );
        let replayComposerDefaults = null;
        let projectSelection = null;
        const scenarioState = await measureTiming(
          "record.scenario-prepare",
          () =>
            recordScenario.prepare({
              agentTargetId,
              async createFixture(name, contents) {
                if (!name || basename(name) !== name) {
                  throw new Error(
                    `record scenario ${recordScenario.id} fixture name is invalid`
                  );
                }
                const path = join(
                  projectRoot,
                  ".tmp",
                  "agent-session-replay-scenario-fixtures",
                  recordScenario.id,
                  name
                );
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, contents);
                scenarioFixturePaths.push(path);
                return relative(projectRoot, path).split("\\").join("/");
              },
              async removePath(path) {
                await rm(path, { force: true });
              },
              async selectProject(project) {
                if (projectSelection) {
                  throw new Error(
                    `record scenario ${recordScenario.id} selected more than one project`
                  );
                }
                projectSelection = resolveRecordScenarioProject(
                  project,
                  projectRoot
                );
                await seedRecordingUserProject(databasePath, projectSelection);
                return projectSelection;
              },
              async setComposerDefaults(defaults) {
                replayComposerDefaults = defaults;
                await setAgentComposerDefaults(
                  databasePath,
                  agentTargetId,
                  defaults,
                  workspaceRoot
                );
              },
              // Scenarios treat workspaceRoot as the bound Agent project tree.
              workspaceRoot: projectRoot
            }),
          { scenario: recordScenario.id }
        );
        if (!replayComposerDefaults) {
          throw new Error(
            `record scenario ${recordScenario.id} did not set composer defaults`
          );
        }
        const action = {
          schemaVersion: 1,
          type: "create-session",
          workspaceId,
          agentTargetId,
          cassetteName: recordScenario.cassetteName,
          scenario: recordScenario,
          scenarioState
        };
        const result = await measureTiming("record.desktop-action", () =>
          runDesktopAction({
            action,
            artifactDirectory: join(runtime.directory, "artifacts"),
            cassetteDirectory: options.cassetteDirectory,
            daemonPath: runtime.daemonPath,
            desktopLaunch: preparedDesktopLaunch(),
            headless: resolveDesktopHeadless(options),
            logPath: join(runtime.directory, "logs", "desktop.log"),
            mode: "record",
            runtime,
            timeoutMs: options.timeoutMs
          })
        );
        if (result.recordingMode !== recordScenario.expectedRecordingMode) {
          throw new Error(
            `record scenario ${recordScenario.id} produced ${result.recordingMode} mode, ` +
              `want ${recordScenario.expectedRecordingMode}`
          );
        }
        await waitForCompleteManifest(
          join(result.recordingDirectory, providerManifestName),
          15_000
        );
        await measureTiming("record.scenario-assert", () =>
          recordScenario.assert({
            phase: "recorded",
            scenarioState,
            async verifyProjectBinding() {
              if (!projectSelection) {
                throw new Error(
                  `record scenario ${recordScenario.id} has no selected project`
                );
              }
              await verifyRecordedProjectBindingArtifacts(
                result.recordingDirectory,
                projectSelection.portablePath
              );
            }
          })
        );
        for (const name of [
          activityEventsName,
          checkpointPlanName,
          "provider",
          "blobs",
          expectedStateName,
          "cassette.json"
        ]) {
          const source = join(result.recordingDirectory, name);
          await cp(source, join(options.cassetteDirectory, name), {
            force: true,
            recursive: true
          });
        }
        try {
          await cp(
            join(result.recordingDirectory, initialStateName),
            join(options.cassetteDirectory, initialStateName),
            { force: true }
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        succeeded = true;
        log(`recorded ${basename(options.cassetteDirectory)}`);
        log(`assistant: ${result.assistantText}`);
      } finally {
        await Promise.all(
          scenarioFixturePaths.map((path) => rm(path, { force: true }))
        );
        if (!succeeded) {
          await logFailureDiagnostics(runtime);
        }
        if (!options.keepRuntime) {
          await removeRuntime(runtime.directory);
        } else {
          log(`runtime kept: ${runtime.directory}`);
        }
        if (!succeeded) {
          log(`incomplete cassette kept: ${options.cassetteDirectory}`);
        }
      }
    },
    { cassetteDirectory: options.cassetteDirectory }
  );
}

async function replayCassette(options) {
  return measureTiming(
    "replay-cassette",
    async () => {
      const manifest = await verifyCassette(options.cassetteDirectory);
      await Promise.all([
        access(join(options.cassetteDirectory, activityEventsName)),
        access(join(options.cassetteDirectory, checkpointPlanName)),
        access(join(options.cassetteDirectory, providerManifestName)),
        access(join(options.cassetteDirectory, expectedStateName)),
        access(join(options.cassetteDirectory, blobManifestName)),
        access(join(options.cassetteDirectory, cassetteManifestName))
      ]);
      const workspaceId = randomUUID();
      const activityEvents = parseActivityEvents(
        await readFile(
          join(options.cassetteDirectory, activityEventsName),
          "utf8"
        )
      );
      const replayProviders = await readReplayProviderIDs(
        options.cassetteDirectory
      );
      const checkpoints = await loadReplayCheckpointPlan(
        options.cassetteDirectory,
        activityEvents
      );
      const replayCassetteId = options.cassetteId ?? manifest.id;
      const action = replayActionFromManifest(
        manifest,
        activityEvents,
        workspaceId
      );
      action.turnIdentityPlan = await loadReplayTurnIdentityPlan(
        options.cassetteDirectory,
        manifest.mode
      );
      const runtime = await createRuntime(workspaceRoot, "replay");
      const desktopLogPath = join(runtime.directory, "logs", "desktop.log");
      const statusPath = join(runtime.directory, "replay-status.json");
      const controlPath = join(runtime.directory, "replay-control.json");
      const databasePath = join(runtime.stateDirectory, "tuttid.db");
      let succeeded = false;
      try {
        await mkdir(dirname(desktopLogPath), { recursive: true });
        // Do not pre-insert the workspace: SemanticRuntime creates it and writes the
        // onboarding-suppressed workbench snapshot. Pre-seeding races that path with
        // "Workspace already exists".
        await initializeCleanDatabase(workspaceRoot, runtime, workspaceId, {
          seedWorkspace: false
        });
        await enableAgentSessionRecordingFeature(databasePath, workspaceRoot);
        // Activation intents can omit composer settings. Restore the values that
        // the cassette itself recorded so provider startup RPCs stay deterministic.
        await setAgentComposerDefaults(
          databasePath,
          manifest.agentTargetId,
          manifest.replayPrerequisites.composerDefaults,
          workspaceRoot
        );
        // Project sessions render under a project rail section. The section only
        // exists when the project is present in user_projects, so replay must
        // re-seed the same project the recording prepared; otherwise the
        // conversation rail never shows the restored session and surface focus
        // stalls forever.
        const replayProject = await loadReplayProject(
          options.cassetteDirectory,
          manifest.rootAgentSessionId
        );
        if (replayProject) {
          await seedRecordingUserProject(databasePath, replayProject);
          action.replayProject = replayProject;
        }
        await materializeReplayWorkspaceBlobs(
          [{ cassetteDirectory: options.cassetteDirectory }],
          runtime.stateDirectory
        );
        const settleScenario =
          options.scenario && options.scenarioFile
            ? await loadRecordScenario(options)
            : null;
        const result = await measureTiming("replay.desktop-action", () =>
          runDesktopAction({
            action,
            artifactDirectory: join(runtime.directory, "artifacts"),
            cassetteDirectory: options.cassetteDirectory,
            checkpoints,
            controlPath,
            daemonPath: runtime.daemonPath,
            desktopLaunch: options.managed
              ? managedDesktopLaunch()
              : preparedDesktopLaunch(),
            headless: resolveDesktopHeadless(options),
            keepDesktopOpen: options.managed,
            logPath: desktopLogPath,
            mode: "replay",
            cassetteId: replayCassetteId,
            screenshotLabel: screenshotEvidenceLabel(options.scenario),
            settleScenario,
            replayRegistrations: [
              {
                cassetteId: replayCassetteId,
                rootAgentSessionId: manifest.rootAgentSessionId,
                cassetteDirectory: join(options.cassetteDirectory, "provider"),
                artifactDirectory: options.cassetteDirectory,
                workspaceId,
                providers: replayProviders,
                frozenModel: manifest.replayPrerequisites.composerDefaults.model
              }
            ],
            initialTargetCheckpoint: options.targetCheckpoint,
            screenshotCheckpoints: options.screenshotCheckpoints === true,
            onCheckpoint: options.managed
              ? (checkpoint) => {
                  process.stdout.write(
                    `${managedReplayCheckpointPrefix}${JSON.stringify({
                      checkpoint,
                      cassetteId: options.cassetteId
                    })}\n`
                  );
                }
              : undefined,
            onCompleted: options.managed
              ? () => {
                  process.stdout.write(
                    `${managedReplayCompletePrefix}${JSON.stringify({
                      cassetteId: options.cassetteId
                    })}\n`
                  );
                }
              : undefined,
            onFailed: options.managed
              ? (error) => {
                  process.stdout.write(
                    `${managedReplayFailedPrefix}${JSON.stringify(
                      managedReplayFailure(options.cassetteId, error)
                    )}\n`
                  );
                }
              : undefined,
            onSurfaceReady: options.managed
              ? () => {
                  process.stdout.write(
                    `${managedReplayReadyPrefix}${JSON.stringify({
                      cassetteId: options.cassetteId,
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
                      cassetteId: options.cassetteId
                    })}\n`
                  );
                }
              : undefined,
            runtime,
            statusPath,
            timeoutMs: options.timeoutMs,
            verifyResult: async () => {
              await verifyReplayTransport(
                runtime.stateDirectory,
                replayCassetteId,
                options.timeoutMs
              );
              const replayLog = await readFile(desktopLogPath, "utf8");
              const failureLine = replayLog
                .split("\n")
                .find(
                  (line) =>
                    line.includes("process cassette outbound mismatch") ||
                    line.includes("process_transport.finalize_failed")
                );
              if (failureLine) {
                throw new Error(
                  `replay transport failed: ${failureLine.trim()}`
                );
              }
            }
          })
        );
        if (result.replaced) {
          succeeded = true;
          return;
        }
        succeeded = true;
        log(`replay passed: ${basename(options.cassetteDirectory)}`);
        log(`assistant: ${result.assistantText}`);
      } finally {
        if (!succeeded) {
          await logFailureDiagnostics(runtime);
        }
        if (!options.keepRuntime) {
          await removeRuntime(runtime.directory);
        } else {
          log(`runtime kept: ${runtime.directory}`);
        }
        if (!succeeded) {
          log("replay failed; cassette was left unchanged");
        }
      }
    },
    { cassetteDirectory: options.cassetteDirectory }
  );
}

async function replayWorkspace(options) {
  const manifest = validateReplayWorkspaceManifest(
    JSON.parse(await readFile(options.replayWorkspaceManifestPath, "utf8"))
  );
  let bootstrap = null;
  try {
    bootstrap = await bootstrapReplayWorkspace(manifest);
    await runReplayWorkspaceOrchestration(bootstrap, options);
  } catch (error) {
    if (options.managed) {
      for (const cassette of manifest.cassettes) {
        process.stdout.write(
          `${managedReplayFailedPrefix}${JSON.stringify(
            managedReplayFailure(cassette.cassetteId, error)
          )}\n`
        );
      }
    }
    throw error;
  } finally {
    if (bootstrap && !options.keepRuntime) {
      await removeRuntime(bootstrap.runtime.directory);
    } else if (bootstrap) {
      log(`runtime kept: ${bootstrap.runtime.directory}`);
    }
  }
}

async function runReplayWorkspaceOrchestration(bootstrap, options) {
  const statusPath = join(bootstrap.runtime.directory, "replay-status.json");
  const controlPath = join(bootstrap.runtime.directory, "replay-control.json");
  const logPath = join(bootstrap.runtime.directory, "logs", "desktop.log");
  await mkdir(dirname(logPath), { recursive: true });
  await writeReplayStatus(statusPath, { phase: "replaying" });
  await writeFile(
    controlPath,
    JSON.stringify({ schemaVersion: 2, cassettes: {} }),
    { mode: 0o600 }
  );
  const cdpPort = await reservePort();
  const desktopLaunch = options.managed
    ? managedDesktopLaunch()
    : preparedDesktopLaunch();
  const initialTargetCheckpoints = new Map(
    bootstrap.cassettes.map((cassette) => [
      cassette.cassetteId,
      replayWorkspaceInitialTargetCheckpoint(
        cassette,
        bootstrap.manifest.playbackMode
      )
    ])
  );
  const desktop = startDesktop({
    args: desktopLaunch?.args,
    cdpPort,
    command: desktopLaunch?.command,
    daemonPath: bootstrap.runtime.daemonPath,
    desktopLogPath: logPath,
    environment: {
      TUTTI_AGENT_CASSETTE_MODE: "replay",
      TUTTI_AGENT_SESSION_REPLAY_REGISTRATIONS: JSON.stringify(
        bootstrap.registrations
      ),
      // Keep the daemon's portable-path anchor identical to the runner's
      // activity-event resolution root; the daemon process cwd is unreliable.
      // When PROJECT_ROOT is set, ${REPLAY_CWD} remaps into that project tree.
      TUTTI_AGENT_SESSION_REPLAY_CWD: projectRoot,
      TUTTI_AGENT_SESSION_REPLAY_CONTROL_PATH: controlPath
    },
    headless: resolveDesktopHeadless(options),
    stateDirectory: bootstrap.runtime.stateDirectory,
    userDataDirectory: bootstrap.runtime.userDataDirectory
  });
  const disposeManagedShutdown = bindManagedReplayShutdown(desktop);
  let client = null;
  try {
    const pageWebSocket = await waitForPageWebSocket(
      cdpPort,
      desktop,
      options.timeoutMs
    );
    client = await CdpClient.connect(pageWebSocket);
    await client.send("Runtime.enable");
    await bootstrapRendererReplayWorkspace(
      client,
      bootstrap.cassettes,
      options.timeoutMs
    );
    const runDesktopUi = createSerialAsyncQueue();
    const reportSurfaceReady = (cassette) =>
      runDesktopUi(async () => {
        await activateRendererReplayWorkspaceCassette(
          client,
          cassette.cassetteId,
          options.timeoutMs
        );
        process.stdout.write(
          `${managedReplayReadyPrefix}${JSON.stringify({
            cassetteId: cassette.cassetteId,
            runtimeDirectory: bootstrap.runtime.directory
          })}\n`
        );
      });
    const workspaceArtifactDirectory = join(
      bootstrap.runtime.directory,
      "artifacts"
    );
    const results = await Promise.all(
      bootstrap.cassettes.map(async (cassette) => {
        const initialTargetCheckpoint = initialTargetCheckpoints.get(
          cassette.cassetteId
        );
        let surfaceReadyReported = false;
        const reportSurfaceReadyOnce = async () => {
          if (surfaceReadyReported) return;
          surfaceReadyReported = true;
          await reportSurfaceReady(cassette);
        };
        const settleAgentSessionId =
          cassette.rootAgentSessionId ||
          cassette.action?.agentSessionId ||
          null;
        try {
          await replayStimuli(
            bootstrap.runtime.stateDirectory,
            cassette.action,
            options.timeoutMs,
            {
              checkpoints: cassette.checkpoints,
              controlPath,
              initialTargetCheckpoint:
                initialTargetCheckpoint === null
                  ? undefined
                  : initialTargetCheckpoint,
              async onCheckpoint(checkpoint) {
                if (options.screenshotCheckpoints) {
                  const checkpointPlan = cassette.checkpoints[checkpoint];
                  await runDesktopUi(async () => {
                    await activateRendererReplayWorkspaceCassette(
                      client,
                      cassette.cassetteId,
                      options.timeoutMs
                    );
                    await maybeSettleForScreenshot(
                      cassette.settleScenario,
                      client,
                      options.timeoutMs,
                      checkpointPlan,
                      settleAgentSessionId
                    );
                    await captureCheckpointScreenshot({
                      agentSessionId: settleAgentSessionId,
                      artifactDirectory: workspaceArtifactDirectory,
                      cassetteId: cassette.cassetteId,
                      checkpointIndex: checkpoint,
                      checkpoints: cassette.checkpoints,
                      client,
                      label: screenshotEvidenceLabel(cassette),
                      prepareToolEvidence:
                        scenarioPreparesToolEvidence(cassette.settleScenario) &&
                        checkpointNeedsToolSettle(checkpointPlan)
                    });
                  });
                }
                process.stdout.write(
                  `${managedReplayCheckpointPrefix}${JSON.stringify({
                    checkpoint,
                    cassetteId: cassette.cassetteId,
                    totalDurationMs: cassette.totalDurationMs,
                    totalCheckpoints: cassette.checkpoints.length
                  })}\n`
                );
                if (checkpoint === initialTargetCheckpoint) {
                  await reportSurfaceReadyOnce();
                }
              },
              async waitForInspectable(_checkpoint, semantic) {
                await reportSurfaceReadyOnce();
                await waitForRendererReplayWorkspaceCheckpoint(
                  client,
                  cassette.cassetteId,
                  semantic,
                  options.timeoutMs
                );
              },
              rendererDriver: createRendererActivityDriver(
                client,
                options.timeoutMs,
                cassette.cassetteId
              ),
              cassetteId: cassette.cassetteId,
              async onStimulusAccepted(stimulus) {
                if (
                  cassette.action.type !== "create-session" ||
                  !["session.create", "session/activate"].includes(
                    stimulus.type
                  )
                ) {
                  return;
                }
                await runDesktopUi(() =>
                  activateRendererReplayWorkspaceCassette(
                    client,
                    cassette.cassetteId,
                    options.timeoutMs
                  )
                );
              }
            }
          );
          await reportSurfaceReadyOnce();
          await verifyReplayTransport(
            bootstrap.runtime.stateDirectory,
            cassette.cassetteId,
            options.timeoutMs
          );
          process.stdout.write(
            `${managedReplayCompletePrefix}${JSON.stringify({
              cassetteId: cassette.cassetteId
            })}\n`
          );
          return { cassetteId: cassette.cassetteId, succeeded: true };
        } catch (error) {
          process.stdout.write(
            `${managedReplayFailedPrefix}${JSON.stringify(
              managedReplayFailure(cassette.cassetteId, error)
            )}\n`
          );
          return { cassetteId: cassette.cassetteId, succeeded: false };
        }
      })
    );
    await writeReplayStatus(statusPath, {
      phase: results.every((result) => result.succeeded) ? "complete" : "failed"
    });
    assertReplayWorkspaceSucceeded(results, options.managed);
    if (options.managed) {
      while (desktop.exitCode === null && desktop.signalCode === null) {
        await delay(100);
      }
    }
  } finally {
    disposeManagedShutdown();
    client?.close();
    await stopProcessTree(desktop);
  }
}

export function createSerialAsyncQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const current = tail.then(() => task());
    tail = current.catch(() => undefined);
    return current;
  };
}

export function createReplayWorkspaceSurfaceReadyQueue(activate) {
  const enqueue = createSerialAsyncQueue();
  return (cassette) => enqueue(() => activate(cassette));
}

export function assertReplayWorkspaceSucceeded(results, managed) {
  const failed = results.filter((result) => !result.succeeded);
  if (failed.length > 0 && !managed) {
    throw new Error(
      `Replay Workspace failed for ${failed.map((result) => result.cassetteId).join(", ")}`
    );
  }
}

export async function bootstrapRendererReplayWorkspace(
  client,
  cassettes,
  timeoutMs
) {
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
      let bridge = globalThis.__tuttiAgentSessionReplayWorkspace;
      while (!bridge && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        bridge = globalThis.__tuttiAgentSessionReplayWorkspace;
      }
      if (!bridge) throw new Error('Replay Workspace bridge is unavailable');
      return await bridge.bootstrap(${JSON.stringify(
        cassettes.map(({ action, cassetteId, rootAgentSessionId, mode }) => ({
          agentTargetId: action.agentTargetId,
          cassetteId,
          rootAgentSessionId,
          mode
        }))
      )});
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description ??
        evaluation.exceptionDetails.text
    );
  }
  return evaluation.result?.value;
}

export async function activateRendererReplayWorkspaceCassette(
  client,
  cassetteId,
  timeoutMs
) {
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const bridge = globalThis.__tuttiAgentSessionReplayWorkspace;
      if (!bridge) throw new Error('Replay Workspace bridge is unavailable');
      return await bridge.activate(${JSON.stringify(cassetteId)});
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description ??
        evaluation.exceptionDetails.text
    );
  }
  await waitForRendererReplayWorkspaceCassette(client, cassetteId, timeoutMs);
  return evaluation.result?.value;
}

async function waitForRendererReplayWorkspaceCassette(
  client,
  cassetteId,
  timeoutMs
) {
  return waitForEvaluation(
    client,
    `(() => {
      const snapshot = globalThis.__tuttiAgentSessionReplayWorkspace?.snapshot();
      const cassette = snapshot?.cassettes.find((candidate) => candidate.cassetteId === ${JSON.stringify(
        cassetteId
      )});
      return { ready: cassette?.ready === true, cassette };
    })()`,
    timeoutMs,
    `ready Replay Workspace Cassette ${cassetteId}`,
    50
  );
}

export async function waitForRendererReplayWorkspaceCheckpoint(
  client,
  cassetteId,
  semantic,
  timeoutMs
) {
  return waitForEvaluation(
    client,
    `(() => {
      const snapshot = globalThis.__tuttiAgentSessionReplayWorkspace?.snapshot();
      const cassette = snapshot?.cassettes.find((candidate) => candidate.cassetteId === ${JSON.stringify(
        cassetteId
      )});
      return {
        ready: cassette?.ready === true &&
          cassette.canonicalSessionUpdatedAtUnixMs >= ${JSON.stringify(
            semantic.canonicalSessionUpdatedAtUnixMs
          )} &&
          cassette.canonicalMessageVersion >= ${JSON.stringify(
            semantic.canonicalMessageVersion
          )},
        cassette
      };
    })()`,
    timeoutMs,
    `inspectable Replay Workspace Checkpoint ${cassetteId}`,
    25
  );
}

export async function waitForRendererAgentSessionCheckpoint(
  client,
  agentSessionId,
  semantic,
  timeoutMs
) {
  return waitForEvaluation(
    client,
    `(() => {
      const observation =
        globalThis.__tuttiAgentSessionReplayWorkspace?.observedSession(
          ${JSON.stringify(agentSessionId)}
        );
      const detail = document.querySelector(
        ${JSON.stringify(`main[data-agent-session-id="${agentSessionId}"]`)}
      );
      const observationReady =
        observation?.updatedAtUnixMs >= ${JSON.stringify(
          semantic.canonicalSessionUpdatedAtUnixMs
        )} &&
          observation.messageVersion >= ${JSON.stringify(
            semantic.canonicalMessageVersion
          )};
      const cassettes =
        globalThis.__tuttiAgentSessionReplayWorkspace
          ?.snapshot()
          ?.cassettes?.map((cassette) => ({
            cassetteId: cassette.cassetteId,
            nodeId: cassette.nodeId,
            mounted: cassette.mounted,
            selectedAgentSessionId: cassette.selectedAgentSessionId,
            detailHydrated: cassette.detailHydrated,
            canonicalMessageVersion: cassette.canonicalMessageVersion,
            canonicalSessionUpdatedAtUnixMs:
              cassette.canonicalSessionUpdatedAtUnixMs,
            ready: cassette.ready
          }));
      return {
        ready: Boolean(detail) && observationReady,
        observation,
        hasDetail: Boolean(detail),
        cassettes
      };
    })()`,
    timeoutMs,
    `inspectable Replay Checkpoint ${agentSessionId}`,
    25
  );
}

export function validateReplayWorkspaceManifest(value) {
  if (
    !value ||
    !Array.isArray(value.cassettes) ||
    value.cassettes.length === 0
  ) {
    throw new Error("Replay Workspace manifest is invalid");
  }
  if (value.playbackMode !== "automatic" && value.playbackMode !== "manual") {
    throw new Error("Replay Workspace playback mode is invalid");
  }
  const cassetteIds = new Set();
  const rootIds = new Set();
  const cassettes = value.cassettes.map((cassette) => {
    const scenario =
      typeof cassette?.scenario === "string" ? cassette.scenario.trim() : "";
    const scenarioFile =
      typeof cassette?.scenarioFile === "string" && cassette.scenarioFile.trim()
        ? resolve(cassette.scenarioFile)
        : "";
    if ((scenario && !scenarioFile) || (!scenario && scenarioFile)) {
      throw new Error(
        "Replay Workspace cassette scenario and scenarioFile must be provided together"
      );
    }
    const normalized = {
      caseId:
        typeof cassette?.caseId === "string" ? cassette.caseId.trim() : "",
      cassetteId:
        typeof cassette?.cassetteId === "string"
          ? cassette.cassetteId.trim()
          : "",
      cassetteDirectory:
        typeof cassette?.cassetteDirectory === "string" &&
        cassette.cassetteDirectory.trim()
          ? resolve(cassette.cassetteDirectory)
          : "",
      rootAgentSessionId:
        typeof cassette?.rootAgentSessionId === "string"
          ? cassette.rootAgentSessionId.trim()
          : "",
      scenario,
      scenarioFile
    };
    if (!normalized.cassetteDirectory) {
      throw new Error("Replay Workspace cassette registration is invalid");
    }
    if (normalized.cassetteId && cassetteIds.has(normalized.cassetteId)) {
      throw new Error(
        `duplicate Replay Workspace cassette: ${normalized.cassetteId}`
      );
    }
    if (
      normalized.rootAgentSessionId &&
      rootIds.has(normalized.rootAgentSessionId)
    ) {
      throw new Error(
        `duplicate Replay Workspace root Session: ${normalized.rootAgentSessionId}`
      );
    }
    if (normalized.cassetteId) cassetteIds.add(normalized.cassetteId);
    if (normalized.rootAgentSessionId) {
      rootIds.add(normalized.rootAgentSessionId);
    }
    return normalized;
  });
  return {
    playbackMode: value.playbackMode,
    workspaceId:
      typeof value.workspaceId === "string" && value.workspaceId.trim()
        ? value.workspaceId.trim()
        : null,
    cassettes
  };
}

export function replayWorkspaceInitialTargetCheckpoint(cassette, playbackMode) {
  if (playbackMode === "automatic") return null;
  const checkpoint = cassette.action.type === "create-session" ? 1 : 0;
  if (!cassette.checkpoints[checkpoint]) {
    throw new Error(
      `Replay Workspace Cassette has no inspectable initial checkpoint: ${cassette.cassetteId}`
    );
  }
  return checkpoint;
}

export async function bootstrapReplayWorkspace(
  manifestValue,
  dependencyOverrides = {}
) {
  const manifest = validateReplayWorkspaceManifest(manifestValue);
  const dependencies = {
    createRuntime: () => createRuntime(workspaceRoot, "replay-workspace"),
    initializeDatabase: async (runtime, workspaceId) => {
      await initializeCleanDatabase(workspaceRoot, runtime, workspaceId, {
        seedWorkspace: false
      });
      await enableAgentSessionRecordingFeature(
        join(runtime.stateDirectory, "tuttid.db"),
        workspaceRoot
      );
    },
    loadCassette: loadReplayWorkspaceCassette,
    materializeBlobs: materializeReplayWorkspaceBlobs,
    removeRuntime,
    seedUserProject: seedRecordingUserProject,
    createWorkspaceId: randomUUID,
    ...dependencyOverrides
  };
  const workspaceId = manifest.workspaceId ?? dependencies.createWorkspaceId();

  // Cassette validation and parsing must finish before allocating a runtime.
  const cassettes = await Promise.all(
    manifest.cassettes.map((cassette) =>
      dependencies.loadCassette(cassette, workspaceId)
    )
  );
  validateLoadedReplayWorkspaceIdentities(cassettes);
  const runtime = await dependencies.createRuntime("replay-workspace");
  try {
    await dependencies.initializeDatabase(runtime, workspaceId);
    const projectsByPath = new Map(
      cassettes
        .map((cassette) => cassette.action.replayProject)
        .filter(Boolean)
        .map((project) => [project.path, project])
    );
    for (const project of projectsByPath.values()) {
      await dependencies.seedUserProject(
        join(runtime.stateDirectory, "tuttid.db"),
        project
      );
    }
    await dependencies.materializeBlobs(cassettes, runtime.stateDirectory);
  } catch (error) {
    await dependencies.removeRuntime(runtime.directory);
    throw error;
  }
  return {
    manifest: { ...manifest, workspaceId },
    registrations: replayWorkspaceTransportRegistrations(cassettes),
    cassettes,
    runtime
  };
}

function validateLoadedReplayWorkspaceIdentities(cassettes) {
  const cassetteIds = new Set();
  const rootSessionIds = new Set();
  for (const cassette of cassettes) {
    if (cassetteIds.has(cassette.cassetteId)) {
      throw new Error(
        `duplicate Replay Workspace cassette: ${cassette.cassetteId}`
      );
    }
    if (rootSessionIds.has(cassette.rootAgentSessionId)) {
      throw new Error(
        `duplicate Replay Workspace root Session: ${cassette.rootAgentSessionId}`
      );
    }
    cassetteIds.add(cassette.cassetteId);
    rootSessionIds.add(cassette.rootAgentSessionId);
  }
}

async function loadReplayWorkspaceCassette(cassette, workspaceId) {
  const cassetteManifest = await verifyCassette(cassette.cassetteDirectory);
  await Promise.all([
    access(join(cassette.cassetteDirectory, activityEventsName)),
    access(join(cassette.cassetteDirectory, checkpointPlanName)),
    access(join(cassette.cassetteDirectory, providerManifestName)),
    access(join(cassette.cassetteDirectory, expectedStateName)),
    access(join(cassette.cassetteDirectory, blobManifestName)),
    access(join(cassette.cassetteDirectory, cassetteManifestName))
  ]);
  const cassetteId = cassetteManifest.id;
  const rootAgentSessionId = cassetteManifest.rootAgentSessionId;
  if (cassette.cassetteId && cassette.cassetteId !== cassetteId) {
    throw new Error(
      `Replay Workspace cassette ${cassette.cassetteId} identity does not match its artifact`
    );
  }
  if (
    cassette.rootAgentSessionId &&
    rootAgentSessionId !== cassette.rootAgentSessionId
  ) {
    throw new Error(
      `Replay Workspace cassette ${cassette.cassetteId} root Session does not match its registration`
    );
  }
  const activityEvents = parseActivityEvents(
    await readFile(join(cassette.cassetteDirectory, activityEventsName), "utf8")
  );
  const totalDurationMs = await readReplayTotalDurationMs(
    cassette.cassetteDirectory,
    cassetteManifest.createdAtUnixMs,
    activityEvents
  );
  const action = replayActionFromManifest(
    cassetteManifest,
    activityEvents,
    workspaceId
  );
  const providers = await readReplayProviderIDs(cassette.cassetteDirectory);
  action.replayProject = await loadReplayProject(
    cassette.cassetteDirectory,
    rootAgentSessionId
  );
  action.turnIdentityPlan = await loadReplayTurnIdentityPlan(
    cassette.cassetteDirectory,
    cassetteManifest.mode
  );
  const settleScenario =
    cassette.scenario && cassette.scenarioFile
      ? await loadRecordScenario({
          scenario: cassette.scenario,
          scenarioFile: cassette.scenarioFile
        })
      : null;
  return {
    ...cassette,
    cassetteId,
    rootAgentSessionId,
    providers,
    replayPrerequisites: cassetteManifest.replayPrerequisites,
    action,
    activityEvents,
    checkpoints: await loadReplayCheckpointPlan(
      cassette.cassetteDirectory,
      activityEvents
    ),
    settleScenario,
    totalDurationMs,
    mode: cassetteManifest.mode
  };
}

async function loadReplayProject(cassetteDirectory, rootAgentSessionId) {
  const expectedState = JSON.parse(
    await readFile(join(cassetteDirectory, expectedStateName), "utf8")
  );
  return resolveReplayProjectFromExpectedState(
    expectedState,
    rootAgentSessionId,
    projectRoot
  );
}

export function resolveReplayProjectFromExpectedState(
  expectedState,
  rootAgentSessionId,
  replayCWD
) {
  const session = expectedState?.agent?.sessions?.find(
    (candidate) => candidate?.id === rootAgentSessionId
  );
  const sectionKey = session?.railSectionKey;
  if (typeof sectionKey !== "string" || !sectionKey.startsWith("project:")) {
    return null;
  }
  const portablePath = sectionKey.slice("project:".length);
  let relativePath;
  if (portablePath === portableReplayCWDToken) {
    relativePath = ".";
  } else if (portablePath.startsWith(`${portableReplayCWDToken}/`)) {
    relativePath = portablePath.slice(portableReplayCWDToken.length + 1);
  } else {
    throw new Error(
      `Replay project binding is not portable: ${portablePath || "<empty>"}`
    );
  }
  const projectPath = resolve(replayCWD, relativePath);
  return resolveRecordScenarioProject(
    { label: basename(projectPath), relativePath },
    replayCWD
  );
}

export async function readReplayTotalDurationMs(
  cassetteDirectory,
  createdAtUnixMs,
  activityEvents
) {
  const eventDurationMs = activityEvents.reduce(
    (duration, event) =>
      Math.max(duration, event.occurredAtUnixMs - createdAtUnixMs),
    0
  );
  let providerDurationMs = 0;
  const frames = createInterface({
    input: createReadStream(
      join(
        dirname(join(cassetteDirectory, providerManifestName)),
        "frames.jsonl"
      )
    ),
    crlfDelay: Infinity
  });
  for await (const line of frames) {
    if (!line.trim()) continue;
    const elapsedMs = JSON.parse(line).elapsedMs;
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("Replay provider frame elapsed time is invalid");
    }
    providerDurationMs = Math.max(providerDurationMs, elapsedMs);
  }
  return Math.max(0, eventDurationMs, providerDurationMs);
}

export function replayWorkspaceTransportRegistrations(cassettes) {
  return cassettes.map((cassette) => {
    const registration = {
      cassetteId: cassette.cassetteId,
      rootAgentSessionId: cassette.rootAgentSessionId,
      cassetteDirectory: join(cassette.cassetteDirectory, "provider"),
      artifactDirectory: cassette.cassetteDirectory,
      workspaceId: cassette.action.workspaceId
    };
    if (Array.isArray(cassette.providers) && cassette.providers.length > 0) {
      registration.providers = cassette.providers;
    }
    const frozenModel = cassette.replayPrerequisites?.composerDefaults?.model;
    if (typeof frozenModel === "string" && frozenModel.trim()) {
      registration.frozenModel = frozenModel.trim();
    }
    return registration;
  });
}

async function readReplayProviderIDs(cassetteDirectory) {
  const manifest = JSON.parse(
    await readFile(join(cassetteDirectory, providerManifestName), "utf8")
  );
  const providers = [
    ...new Set(
      (Array.isArray(manifest.connections) ? manifest.connections : [])
        .map((connection) =>
          typeof connection?.provider === "string"
            ? connection.provider.trim()
            : ""
        )
        .filter(Boolean)
    )
  ];
  if (providers.length === 0) {
    throw new Error("Replay provider manifest has no providers");
  }
  return providers;
}

async function loadReplayTurnIdentityPlan(cassetteDirectory, mode) {
  const expectedState = JSON.parse(
    await readFile(join(cassetteDirectory, expectedStateName), "utf8")
  );
  const initialState =
    mode === "continue-session"
      ? JSON.parse(
          await readFile(join(cassetteDirectory, initialStateName), "utf8")
        )
      : null;
  return replayTurnIdentityPlan(expectedState, initialState);
}

export function replayTurnIdentityPlan(expectedState, initialState = null) {
  const expectedSessions = expectedState?.agent?.sessions;
  const initialSessions = new Map(
    (initialState?.agent?.sessions ?? []).map((session) => [
      session.id,
      new Set((session.turns ?? []).map((turn) => turn.id))
    ])
  );
  if (!Array.isArray(expectedSessions)) {
    throw new Error("expected replay state has no Agent Sessions");
  }
  return Object.fromEntries(
    expectedSessions.map((session) => {
      const initialTurnIds = initialSessions.get(session.id) ?? new Set();
      const recordedTurnIds = (session.turns ?? [])
        .map((turn) => turn.id)
        .filter((turnId) => !initialTurnIds.has(turnId));
      if (
        typeof session.id !== "string" ||
        recordedTurnIds.some(
          (turnId) => typeof turnId !== "string" || !turnId.trim()
        )
      ) {
        throw new Error("expected replay state has invalid Turn identities");
      }
      return [
        session.id,
        {
          initialTurnIds: [...initialTurnIds],
          recordedTurnIds,
          ...(session.kind === "child"
            ? {
                kind: "child",
                initialSession: initialSessions.has(session.id),
                rootSessionId: session.rootSessionId,
                rootTurnId: session.rootTurnId,
                parentSessionId: session.parentSessionId,
                parentTurnId: session.parentTurnId,
                parentToolCallId: session.parentToolCallId
              }
            : {})
        }
      ];
    })
  );
}

export async function verifyReplayWorkspaceTransports(
  stateDirectory,
  cassettes,
  timeoutMs,
  verify = verifyReplayTransport
) {
  return Promise.all(
    cassettes.map(async (cassette) => {
      try {
        await verify(stateDirectory, cassette.cassetteId, timeoutMs);
        return { cassetteId: cassette.cassetteId, verified: true };
      } catch (error) {
        return {
          cassetteId: cassette.cassetteId,
          verified: false,
          error: replayStatusErrorMessage(error)
        };
      }
    })
  );
}

async function runDesktopAction(input) {
  await mkdir(input.artifactDirectory, { recursive: true });
  await mkdir(dirname(input.logPath), { recursive: true });
  if (input.mode === "replay") {
    await writeFile(
      input.controlPath,
      JSON.stringify(replayControlRouter(input.cassetteId, 0, "resume"))
    );
  }
  await writeReplayStatus(input.statusPath, {
    phase: "replaying",
    ...(input.mode === "replay"
      ? {
          currentCheckpoint: 0,
          totalCheckpoints: input.checkpoints.length,
          paused: false,
          timingMode:
            process.env.TUTTI_AGENT_SESSION_REPLAY_TIMING_MODE?.trim() ===
            "realtime"
              ? "realtime"
              : "fast-forward",
          targetCheckpoint: null
        }
      : {})
  });
  const cdpPort = await reservePort();
  const replayRegistrations =
    input.mode === "replay"
      ? requiredReplayRegistrations(input.replayRegistrations)
      : null;
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
            TUTTI_AGENT_SESSION_REPLAY_REGISTRATIONS:
              JSON.stringify(replayRegistrations),
            // The daemon resolves portable `${REPLAY_CWD}` state against this
            // anchor. Its process cwd is not reliable (the desktop launcher
            // may start it from `apps/desktop`), so pin the same root the
            // runner uses to resolve portable activity-event payloads.
            // When PROJECT_ROOT is set, that root is the Agent user-project.
            TUTTI_AGENT_SESSION_REPLAY_CWD: projectRoot,
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
    const reportSurfaceReady = () => {
      if (surfaceReady) return;
      surfaceReady = true;
      input.onSurfaceReady?.();
    };
    if (input.mode === "record") {
      await prepareAgentSessionSurface(
        pageClient,
        input.action,
        input.timeoutMs
      );
      if (input.action.scenario.setupInitialState) {
        await input.action.scenario.setupInitialState({
          client: pageClient,
          scenarioState: input.action.scenarioState,
          timeoutMs: input.timeoutMs
        });
        await waitForIdleAgentComposer(pageClient, input.timeoutMs);
      }
      await startSessionRecording(pageClient, input.timeoutMs);
    }
    let settled = null;
    if (input.mode === "replay") {
      // Replay must not dock-launch its own AgentGUI surface: the Replay
      // Workspace bootstrap launches the single Agent Node that the cassette
      // binds to. A pre-launched node would swallow the DOM interactions while
      // observations wait on the coordinator-launched node forever.
      await bootstrapRendererReplayWorkspace(
        pageClient,
        [
          {
            action: input.action,
            cassetteId: input.cassetteId,
            rootAgentSessionId: input.action.agentSessionId,
            mode: input.action.type
          }
        ],
        input.timeoutMs
      );
      await waitForIdleAgentComposer(pageClient, input.timeoutMs);
      // Project sessions record their activation from a project-scoped
      // composer. Replaying the activation from the default conversations
      // surface would create the session without the project binding (cwd
      // and rail placement), so enter the seeded project first, exactly like
      // the recording scenario did.
      if (
        input.action.type === "create-session" &&
        input.action.replayProject?.id
      ) {
        await startReplayProjectSession(
          pageClient,
          input.action.replayProject.id,
          input.timeoutMs
        );
      }
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
          cassetteId: input.cassetteId,
          async onCheckpoint(checkpoint) {
            if (input.screenshotCheckpoints) {
              const checkpointPlan = input.checkpoints[checkpoint];
              await maybeSettleForScreenshot(
                input.settleScenario,
                pageClient,
                input.timeoutMs,
                checkpointPlan,
                input.action.agentSessionId
              );
              await captureCheckpointScreenshot({
                agentSessionId: input.action.agentSessionId,
                artifactDirectory: input.artifactDirectory,
                checkpointIndex: checkpoint,
                checkpoints: input.checkpoints,
                client: pageClient,
                label: input.screenshotLabel,
                prepareToolEvidence:
                  scenarioPreparesToolEvidence(input.settleScenario) &&
                  checkpointNeedsToolSettle(checkpointPlan)
              });
            }
            await input.onCheckpoint?.(checkpoint);
          },
          onReplacement: input.onReplacement,
          async waitForInspectable(_checkpoint, semantic) {
            // Checkpoints can become provider-ready before session/activate
            // finishes. Focus the recorded session without waiting for a stable
            // idle rail (turns may keep busy indicators visible).
            await focusReplaySessionDetailSurface(
              pageClient,
              input.action,
              input.timeoutMs
            );
            if (input.action.type === "create-session") {
              reportSurfaceReady();
            }
            await waitForRendererAgentSessionCheckpoint(
              pageClient,
              input.action.agentSessionId,
              semantic,
              input.timeoutMs
            );
          },
          rendererDriver: createRendererActivityDriver(
            pageClient,
            input.timeoutMs,
            input.cassetteId
          ),
          statusPath: input.statusPath,
          async onStimulusAccepted(stimulus) {
            if (
              input.action.type !== "create-session" ||
              !["session.create", "session/activate"].includes(stimulus.type)
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
          const detailText = detail?.textContent?.trim() ?? '';
          const text = [...(detail?.querySelectorAll('[data-workspace-agent-markdown="true"]') ?? [])]
            .at(-1)
            ?.textContent?.trim() ?? detailText;
          return {
            ready: Boolean(detail) &&
              !document.querySelector('[data-testid="agent-gui-composer-stop-active-turn"]'),
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
    if (input.mode === "record") {
      async function captureEvidence(name) {
        if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
          throw new Error(`invalid scenario evidence name: ${name}`);
        }
        await captureScreenshot(
          pageClient,
          join(input.artifactDirectory, `${name}.png`)
        );
      }
      await input.action.scenario.drive({
        captureEvidence,
        client: pageClient,
        scenarioState: input.action.scenarioState,
        timeoutMs: input.timeoutMs
      });
      settled = await input.action.scenario.assert({
        assertPathAbsent: (path) =>
          assertForbiddenPathAbsent(path, input.action.scenario.id),
        captureEvidence,
        client: pageClient,
        phase: "terminal",
        scenarioState: input.action.scenarioState,
        timeoutMs: input.timeoutMs
      });
    }
    const settleScenario =
      input.mode === "record" ? input.action.scenario : input.settleScenario;
    await maybeSettleForScreenshot(
      settleScenario,
      pageClient,
      input.timeoutMs,
      null,
      input.action.agentSessionId
    );
    await captureScreenshot(
      pageClient,
      join(input.artifactDirectory, `${input.mode}-agent-gui.png`)
    );
    if (!settled.activeSessionId) {
      throw new Error("settled Agent turn has no active Session identity");
    }
    let recordingDirectory = null;
    let recordingMode = null;
    if (input.mode === "record") {
      const completedRecording = await stopSessionRecording(
        pageClient,
        input.runtime.stateDirectory,
        input.action.workspaceId,
        input.timeoutMs,
        input.action.cassetteName
      );
      recordingDirectory = completedRecording.directory;
      recordingMode = completedRecording.mode;
    }
    result = {
      activeSessionId: settled.activeSessionId,
      assistantText: settled.assistantText,
      recordingDirectory,
      recordingMode
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

function requiredReplayRegistrations(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Replay registrations are required");
  }
  for (const registration of value) {
    if (
      !registration ||
      typeof registration.cassetteId !== "string" ||
      !registration.cassetteId.trim() ||
      typeof registration.rootAgentSessionId !== "string" ||
      !registration.rootAgentSessionId.trim() ||
      typeof registration.cassetteDirectory !== "string" ||
      !registration.cassetteDirectory.trim()
    ) {
      throw new Error("Replay registration is invalid");
    }
  }
  return value;
}

async function writeReplayStatus(path, status) {
  if (!path) return;
  let previous = {};
  try {
    previous = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify({ ...previous, ...status }));
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createRendererActivityDriver(client, timeoutMs, cassetteId) {
  if (typeof cassetteId !== "string" || cassetteId.trim() === "") {
    throw new Error("renderer activity driver requires cassetteId");
  }
  const normalizedCassetteId = cassetteId.trim();
  const invoke = async (method, event) => {
    const argumentsJSON = `${JSON.stringify(normalizedCassetteId)}, ${JSON.stringify(event)}`;
    const invocationKey = `${method}:${event.eventId}`;
    const expression = `(async () => {
        const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
        const invocations = globalThis.__tuttiAgentSessionReplayInvocations ??=
          new Map();
        let invocation = invocations.get(${JSON.stringify(invocationKey)});
        if (!invocation) {
          invocation = { done: false, error: null, value: undefined };
          invocations.set(${JSON.stringify(invocationKey)}, invocation);
        }
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
        if (!invocation.started) {
          invocation.started = true;
          Promise.resolve(
            driver[${JSON.stringify(method)}](${argumentsJSON})
          ).then(
            (value) => {
              invocation.value = value;
              invocation.done = true;
            },
            (error) => {
              invocation.error =
                error instanceof Error ? error.stack ?? error.message : String(error);
              invocation.done = true;
            }
          );
        }
        while (!invocation.done && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!invocation.done) throw new Error('renderer replay invocation timed out');
        if (invocation.error) throw new Error(invocation.error);
        return invocation.value;
      })()`;
    const deadline = Date.now() + timeoutMs;
    let evaluation;
    while (true) {
      try {
        evaluation = await client.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: Math.max(1, deadline - Date.now())
        });
        break;
      } catch (error) {
        if (
          !String(error?.message ?? error).includes("Promise was collected") ||
          Date.now() >= deadline
        ) {
          throw error;
        }
      }
    }
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
      return invoke("dispatchCassetteIntent", event);
    },
    verifyEffect(event) {
      return invoke("verifyCassetteEffect", event);
    },
    waitUntilIntentReady(event) {
      return invoke("waitUntilCassetteIntentReady", event);
    }
  };
}

function replayStatusErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 12_000);
}

export function managedReplayFailure(cassetteId, error) {
  const cause = structuredReplayFailureCause(
    error instanceof Error ? error.cause : null
  );
  return {
    ...(cause ? { cause } : {}),
    cassetteId,
    error: replayStatusErrorMessage(error)
  };
}

function structuredReplayFailureCause(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.code !== "string" ||
    !value.code.trim() ||
    typeof value.message !== "string" ||
    !value.message.trim()
  ) {
    return null;
  }
  return {
    code: value.code.trim(),
    message: value.message.trim()
  };
}

async function verifyReplayTransport(stateDirectory, cassetteId, timeoutMs) {
  const listener = JSON.parse(
    await readFile(replayListenerInfoPath(stateDirectory), "utf8")
  );
  const baseURL = `http://${listener.addr}`;
  const headers = {
    authorization: `Bearer ${listener.auth.token}`
  };
  const deadline = Date.now() + timeoutMs;
  const transportPath = `/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport`;
  let latestPlayback = null;
  let nextHardFailureCheckAt = 0;
  while (Date.now() < deadline) {
    const playbackResponse = await fetch(
      `${baseURL}${transportPath}/playback`,
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
    // Fail fast on hard outbound faults instead of waiting out the full
    // drain timeout while playback.drained stays false.
    if (Date.now() >= nextHardFailureCheckAt) {
      nextHardFailureCheckAt = Date.now() + 500;
      const earlyFailure = await readReplayTransportHardFailure(
        baseURL,
        headers,
        cassetteId,
        timeoutMs
      );
      if (earlyFailure) {
        throw new Error(
          `replay transport failed before drain: ${earlyFailure}; playback=${JSON.stringify(latestPlayback)}`
        );
      }
    }
    await delay(50);
  }
  if (latestPlayback?.drained !== true) {
    const lateFailure = await readReplayTransportHardFailure(
      baseURL,
      headers,
      cassetteId,
      timeoutMs
    );
    throw new Error(
      `replay transport did not drain before verification: ${JSON.stringify(latestPlayback)}` +
        (lateFailure ? `; transport=${lateFailure}` : "")
    );
  }
  const response = await fetch(`${baseURL}${transportPath}/verify`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(
      `replay transport verification failed with ${response.status}: ${await response.text()}`
    );
  }
}

export function replayTransportHardFailureMessage(status, body) {
  if (status !== 409 || typeof body !== "string" || body.trim() === "") {
    return "";
  }
  if (
    body.includes("outbound mismatch") ||
    body.includes("unexpected outbound bytes after cassette end")
  ) {
    return body.trim();
  }
  return "";
}

async function readReplayTransportHardFailure(
  baseURL,
  headers,
  cassetteId,
  timeoutMs
) {
  try {
    const response = await fetch(
      `${baseURL}/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport/verify`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    if (response.ok) return "";
    return replayTransportHardFailureMessage(
      response.status,
      await response.text()
    );
  } catch {
    return "";
  }
}

export { bindManagedReplayShutdown } from "./agent-session-replay-runner/desktop-shutdown.mjs";

export async function replayStimuli(
  stateDirectory,
  action,
  timeoutMs,
  input = {}
) {
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length === 0) {
    throw new Error("replay checkpoints are required");
  }
  const cassetteId = requiredReplayCassetteId(input.cassetteId);
  const listener = JSON.parse(
    await readFile(replayListenerInfoPath(stateDirectory), "utf8")
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
    cassetteId,
    statusPath: input.statusPath,
    targetCheckpoint: input.initialTargetCheckpoint,
    verifyBootstrap: action.type === "continue-session",
    waitForInspectable: input.waitForInspectable,
    timeoutMs
  });
  const turnIdentities = createReplayTurnIdentityTracker(
    action.turnIdentityPlan ?? {},
    { baseURL, headers, timeoutMs }
  );
  await playback.initialize();
  assertNoDuplicateEngineSends(action.activityEvents);
  const totalActivityEvents = action.activityEvents.length;
  for (const event of action.activityEvents) {
    log(
      `activity ${event.sequence}/${totalActivityEvents}: ` +
        `${event.kind} ${event.type}`
    );
    await playback.waitUntilRunnable();
    await playback.waitBeforeActivity(event.sequence);
    await playback.waitForRecordedEvent(event.occurredAtUnixMs);
    if (submitRequestedRequiresSessionIdle(event, action.activityEvents)) {
      await waitForSessionIdle(
        baseURL,
        headers,
        event.workspaceId,
        event.agentSessionId,
        timeoutMs,
        playback
      );
    }
    if (event.kind === "intent" && event.type === "plan/feedbackRequested") {
      await waitForSessionIdle(
        baseURL,
        headers,
        event.workspaceId,
        event.agentSessionId,
        timeoutMs,
        playback
      );
    }
    switch (event.kind) {
      case "intent":
        if (!input.rendererDriver?.dispatchIntent) {
          throw new Error(
            `renderer activity driver is required for intent ${event.type}`
          );
        }
        const replayIntent = await turnIdentities.rebase(event);
        await playback.runWhilePolling(() =>
          input.rendererDriver.waitUntilIntentReady?.(replayIntent)
        );
        await playback.runWhilePolling(() =>
          input.rendererDriver.dispatchIntent(replayIntent)
        );
        break;
      case "effect":
        if (!input.rendererDriver?.verifyEffect) {
          throw new Error(
            `renderer activity driver is required for effect ${event.type}`
          );
        }
        const replayEffect = await turnIdentities.rebase(event);
        await playback.runWhilePolling(() =>
          input.rendererDriver.verifyEffect(replayEffect)
        );
        break;
      case "direct-stimulus":
        await playback.runWhilePolling(() =>
          replayDirectStimulus({
            baseURL,
            event,
            headers,
            playback,
            cassetteId,
            turnIdentities,
            timeoutMs
          })
        );
        await input.onStimulusAccepted?.(event);
        break;
      default:
        throw new Error(`unsupported replay activity kind: ${event.kind}`);
    }
    if (replayEventMayStartTurn(event)) {
      await turnIdentities.observeCurrentTurn(
        event.workspaceId,
        event.agentSessionId
      );
    }
    await input.onActivityEventCompleted?.(event);
    if (event.kind === "effect" && event.type === "session/activate") {
      await input.onStimulusAccepted?.(event);
    }
    await playback.activityAdvanced(event.sequence);
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
  await playback.waitForAllCheckpoints();
  await playback.waitUntilRunnable();
  return playback;
}

async function replayDirectStimulus({
  baseURL,
  event,
  headers,
  playback,
  cassetteId,
  turnIdentities,
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
  const replayEvent = await turnIdentities.rebase(event);
  let readyEvent = replayEvent;
  if (event.type === "interactive.response") {
    readyEvent = await waitForPendingReplayInteraction(
      baseURL,
      headers,
      replayEvent,
      timeoutMs,
      playback
    );
  }
  const request = replayStimulusRequest(readyEvent);
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
          ? await replayTransportFailure(
              baseURL,
              headers,
              cassetteId,
              timeoutMs
            )
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

function replayEventMayStartTurn(event) {
  return (
    ["session.create", "session.send"].includes(event.type) ||
    (event.kind === "effect" &&
      ["queue/sendPrompt", "session/activate"].includes(event.type))
  );
}

/**
 * Wait for session idle before replaying a submit only when that submit is
 * expected to drain into a send. Busy-queue submits (and send_now/immediate)
 * must not wait — the active turn is why they were queued, and idle arrives
 * only after later tape actions (edit/remove/send-now) intervene.
 *
 * Prefer explicit submitDiagnostics.queued when present; otherwise infer from
 * whether this intent caused a send/activate effect (covers older cassettes
 * that stamped queued:false before engine admission was recorded).
 */
export function submitRequestedRequiresSessionIdle(event, activityEvents) {
  if (event?.kind !== "intent" || event.type !== "submit/requested") {
    return false;
  }
  if (event.payload?.submitDiagnostics?.queued === true) {
    return false;
  }
  const routing = event.payload?.routing;
  if (routing === "send_now" || routing === "immediate") {
    return false;
  }
  return submitRequestedCausedSend(event, activityEvents);
}

function submitRequestedCausedSend(event, activityEvents) {
  const eventId = event.eventId;
  if (!eventId || !Array.isArray(activityEvents)) {
    // Without a causable tape identity, treat non-queued auto submits as
    // needing idle (the historical runner default).
    return event.payload?.submitDiagnostics?.queued !== true;
  }
  return activityEvents.some(
    (candidate) =>
      candidate.kind === "effect" &&
      (candidate.type === "queue/sendPrompt" ||
        candidate.type === "session/activate") &&
      candidate.causedByEventId === eventId
  );
}

function createReplayTurnIdentityTracker(plan, runtime) {
  const sessions = new Map(
    Object.entries(plan).map(([sessionId, session]) => [
      sessionId,
      {
        actualSessionId:
          session.kind === "child" && session.initialSession !== true
            ? null
            : sessionId,
        actualTurnIds: new Set(),
        initialTurnIds: new Set(session.initialTurnIds ?? []),
        kind: session.kind ?? "root",
        parentSessionId: session.parentSessionId ?? null,
        parentToolCallId: session.parentToolCallId ?? null,
        parentTurnId: session.parentTurnId ?? null,
        rootSessionId: session.rootSessionId ?? null,
        rootTurnId: session.rootTurnId ?? null,
        mappedTurnIds: new Map(),
        recordedTurnIds: session.recordedTurnIds ?? []
      }
    ])
  );

  const observeSessionTurn = (recordedSessionId, session) => {
    const identity = sessions.get(recordedSessionId);
    if (!identity) return;
    const actualTurnId = session.activeTurnId ?? session.latestTurn?.id ?? null;
    if (!actualTurnId || identity.actualTurnIds.has(actualTurnId)) return;
    const recordedTurnId =
      identity.recordedTurnIds[identity.mappedTurnIds.size];
    if (!recordedTurnId) {
      throw new Error(
        `replay Session ${recordedSessionId} produced an unexpected Turn ${actualTurnId}`
      );
    }
    identity.actualTurnIds.add(actualTurnId);
    identity.mappedTurnIds.set(recordedTurnId, actualTurnId);
  };

  const mappedTurnId = (recordedSessionId, recordedTurnId) => {
    const identity = sessions.get(recordedSessionId);
    if (!identity || identity.initialTurnIds.has(recordedTurnId)) {
      return recordedTurnId;
    }
    return identity.mappedTurnIds.get(recordedTurnId) ?? null;
  };

  const readSession = async (workspaceId, actualSessionId) => {
    const response = await fetch(
      `${runtime.baseURL}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(actualSessionId)}`,
      { headers: runtime.headers }
    );
    if (!response.ok) {
      throw new Error(
        `failed to resolve replay Session identity: ${response.status} ${await response.text()}`
      );
    }
    const detail = await response.json();
    return detail.session ?? detail;
  };

  const observeCurrentTurn = async (workspaceId, recordedSessionId) => {
    const actualSessionId = await resolveSession(
      workspaceId,
      recordedSessionId
    );
    const session = await readSession(workspaceId, actualSessionId);
    observeSessionTurn(recordedSessionId, session);
  };

  const resolveLineageTurn = async (
    workspaceId,
    recordedSessionId,
    recordedTurnId
  ) => {
    if (!recordedTurnId) return null;
    let actualTurnId = mappedTurnId(recordedSessionId, recordedTurnId);
    if (actualTurnId) return actualTurnId;
    await observeCurrentTurn(workspaceId, recordedSessionId);
    actualTurnId = mappedTurnId(recordedSessionId, recordedTurnId);
    if (!actualTurnId) {
      throw new Error(
        `replay lineage Turn identity is unresolved: ${recordedSessionId}/${recordedTurnId}`
      );
    }
    return actualTurnId;
  };

  const readSessionGraph = async (workspaceId, rootSessionId) => {
    const response = await fetch(
      `${runtime.baseURL}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(rootSessionId)}?projection=messageHydration`,
      { headers: runtime.headers }
    );
    if (!response.ok) {
      throw new Error(
        `failed to read replay Session graph: ${response.status} ${await response.text()}`
      );
    }
    const body = await response.json();
    return [
      ...(body.session ? [body.session] : []),
      ...(Array.isArray(body.childSessions) ? body.childSessions : [])
    ];
  };

  const resolveSession = async (workspaceId, recordedSessionId) => {
    const identity = sessions.get(recordedSessionId);
    if (!identity) return recordedSessionId;
    if (identity.actualSessionId) return identity.actualSessionId;
    if (
      identity.kind !== "child" ||
      !identity.rootSessionId ||
      !identity.parentSessionId ||
      !identity.parentToolCallId
    ) {
      throw new Error(
        `replay child Session lineage is incomplete: ${recordedSessionId}`
      );
    }
    const actualRootSessionId = await resolveSession(
      workspaceId,
      identity.rootSessionId
    );
    const actualParentSessionId = await resolveSession(
      workspaceId,
      identity.parentSessionId
    );
    const actualRootTurnId = await resolveLineageTurn(
      workspaceId,
      identity.rootSessionId,
      identity.rootTurnId
    );
    const actualParentTurnId = await resolveLineageTurn(
      workspaceId,
      identity.parentSessionId,
      identity.parentTurnId
    );
    const deadline = Date.now() + runtime.timeoutMs;
    while (Date.now() < deadline) {
      const candidates = (
        await readSessionGraph(workspaceId, actualRootSessionId)
      ).filter(
        (session) =>
          session.kind === "child" &&
          session.rootAgentSessionId === actualRootSessionId &&
          session.parentAgentSessionId === actualParentSessionId &&
          session.parentToolCallId === identity.parentToolCallId &&
          (!actualRootTurnId || session.rootTurnId === actualRootTurnId) &&
          (!actualParentTurnId || session.parentTurnId === actualParentTurnId)
      );
      if (candidates.length > 1) {
        throw new Error(
          `replay child Session lineage is ambiguous: ${recordedSessionId}`
        );
      }
      if (candidates.length === 1) {
        identity.actualSessionId = candidates[0].id;
        observeSessionTurn(recordedSessionId, candidates[0]);
        return identity.actualSessionId;
      }
      await delay(50);
    }
    throw new Error(
      `replay child Session identity is unresolved: ${recordedSessionId}`
    );
  };

  return {
    observeCurrentTurn,
    async rebase(event) {
      const recordedSessionId = event.agentSessionId;
      const actualSessionId = await resolveSession(
        event.workspaceId,
        recordedSessionId
      );
      const recordedTurnId = event.payload?.turnId;
      if (typeof recordedTurnId !== "string") {
        return actualSessionId === recordedSessionId
          ? event
          : { ...event, agentSessionId: actualSessionId };
      }
      const identity = sessions.get(recordedSessionId);
      if (!identity) return event;
      if (!identity || identity.initialTurnIds.has(recordedTurnId)) {
        return actualSessionId === recordedSessionId
          ? event
          : { ...event, agentSessionId: actualSessionId };
      }
      let actualTurnId = identity.mappedTurnIds.get(recordedTurnId);
      if (!actualTurnId) {
        await observeCurrentTurn(event.workspaceId, recordedSessionId);
        actualTurnId = identity.mappedTurnIds.get(recordedTurnId);
      }
      if (!actualTurnId) {
        throw new Error(
          `replay Turn identity is unresolved: ${recordedSessionId}/${recordedTurnId}`
        );
      }
      const payload = {
        ...event.payload,
        turnId: actualTurnId,
        ...([
          "plan.decision",
          "plan/decisionRequested",
          "plan/submitDecision"
        ].includes(event.type) && event.payload.requestId === recordedTurnId
          ? {
              requestId: actualTurnId
            }
          : {})
      };
      return {
        ...event,
        agentSessionId: actualSessionId,
        ...(event.type === "interaction/respond" ||
        event.type === "plan/submitDecision"
          ? {
              correlationId: replayScopedEntityKey(
                actualSessionId,
                replayScopedEntityKey(payload.turnId, payload.requestId)
              )
            }
          : {}),
        payload
      };
    }
  };
}

function replayScopedEntityKey(scopeId, entityId) {
  const scope = scopeId.trim();
  return `${scope.length}:${scope}${entityId.trim()}`;
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

export async function loadReplayCheckpointPlan(
  cassetteDirectory,
  activityEvents
) {
  const plan = JSON.parse(
    await readFile(join(cassetteDirectory, checkpointPlanName), "utf8")
  );
  return validateReplayCheckpointPlan(plan, activityEvents);
}

export function validateReplayCheckpointPlan(plan, activityEvents) {
  if (
    plan?.schemaVersion !== 2 ||
    plan.cassetteSchemaVersion !== cassettePolicy.schemaVersion ||
    plan.observationSchemaVersion !== 2 ||
    !Array.isArray(plan.checkpoints) ||
    plan.checkpoints.length === 0
  ) {
    throw new Error("checkpoint_plan_invalid: unsupported plan schema");
  }
  let previousActivitySequence = 0;
  const ids = new Set();
  for (const [index, checkpoint] of plan.checkpoints.entries()) {
    if (
      checkpoint?.index !== index ||
      checkpoint.id !== `checkpoint-${String(index).padStart(4, "0")}` ||
      ids.has(checkpoint.id) ||
      typeof checkpoint.kind !== "string" ||
      !Array.isArray(checkpoint.tags) ||
      !checkpoint.tags.includes(checkpoint.kind) ||
      !Number.isSafeInteger(checkpoint.cursor?.activityEventSequence) ||
      checkpoint.cursor.activityEventSequence < previousActivitySequence ||
      !Array.isArray(checkpoint.cursor.providerConnections) ||
      !["bootstrap", "activity-boundary", "provider-observation"].includes(
        checkpoint.trigger?.source
      )
    ) {
      throw new Error(`checkpoint_plan_invalid: checkpoint ${index}`);
    }
    if (
      checkpoint.trigger.source === "activity-boundary" &&
      checkpoint.trigger.afterActivityEventSequence !==
        checkpoint.cursor.activityEventSequence
    ) {
      throw new Error(
        `checkpoint_plan_invalid: activity boundary ${checkpoint.id}`
      );
    }
    if (
      checkpoint.cursor.activityEventSequence >
      (activityEvents.at(-1)?.sequence ?? 0)
    ) {
      throw new Error(
        `checkpoint_plan_invalid: activity cursor ${checkpoint.id}`
      );
    }
    ids.add(checkpoint.id);
    previousActivitySequence = checkpoint.cursor.activityEventSequence;
  }
  if (plan.checkpoints[0].trigger.source !== "bootstrap") {
    throw new Error("checkpoint_plan_invalid: checkpoint zero");
  }
  return plan.checkpoints;
}

export function createReplayPlaybackController(input) {
  const cassetteId = requiredReplayCassetteId(input.cassetteId);
  const bySequence = new Map(
    input.checkpoints
      .slice(1)
      .filter((checkpoint) => checkpoint.trigger.source === "activity-boundary")
      .map((checkpoint) => [
        checkpoint.trigger.afterActivityEventSequence,
        checkpoint
      ])
  );
  let currentCheckpoint = 0;
  let lastRevision = 0;
  let paused = false;
  const automatic = input.targetCheckpoint === undefined;
  let targetCheckpoint = automatic
    ? input.checkpoints.length > 1
      ? 1
      : null
    : input.targetCheckpoint;
  let targetDeadline = null;
  let activityEventSequence = 0;
  const timingModeEnv =
    process.env.TUTTI_AGENT_SESSION_REPLAY_TIMING_MODE?.trim() || "";
  // preferFastForward: opt-in batch mode that keeps FF even after landing a
  // checkpoint (env === "fast-forward"). Default seeking still uses FF via
  // setFastForward, then setRealtime restores realtime on land — unless the
  // operator explicitly requested realtime seeking for busy-queue visuals.
  const preferFastForward = timingModeEnv === "fast-forward";
  const forceRealtimeSeek = timingModeEnv === "realtime";
  let timingMode = "realtime";
  const transportPlaybackPath = `/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport/playback`;
  const checkpointVerificationPath = (checkpointIndex) =>
    `/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/checkpoints/${checkpointIndex}/verify`;

  const updateStatus = () =>
    writeReplayStatus(input.statusPath, {
      currentCheckpoint,
      totalCheckpoints: input.checkpoints.length,
      paused,
      timingMode,
      targetCheckpoint
    });

  const setTransport = async (command) => {
    const response = await fetch(`${input.baseURL}${transportPlaybackPath}`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(
        `replay playback command failed with ${response.status}: ${await response.text()}`
      );
    }
  };

  const readTransportPlayback = async () => {
    const response = await fetch(`${input.baseURL}${transportPlaybackPath}`, {
      headers: input.headers,
      signal: AbortSignal.timeout(input.timeoutMs)
    });
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
      !Array.isArray(state.providerConnections) ||
      !["realtime", "fast-forward"].includes(state.timingMode)
    ) {
      throw new Error("replay playback state is invalid");
    }
    return state;
  };

  const setRealtime = async () => {
    if (preferFastForward) {
      if (timingMode === "fast-forward") return;
      await setTransport({
        command: "set-timing-mode",
        timingMode: "fast-forward"
      });
      timingMode = "fast-forward";
      return;
    }
    if (timingMode === "realtime") return;
    await setTransport({
      command: "set-timing-mode",
      timingMode: "realtime"
    });
    timingMode = "realtime";
  };

  const setFastForward = async () => {
    // Explicit realtime keeps seeking in realtime. Forcing FF here lets the
    // provider finish a long busy turn before queued submit/requested intents
    // are dispatched, so the composer queue never becomes visible.
    if (forceRealtimeSeek) {
      await setRealtime();
      return;
    }
    if (timingMode === "fast-forward") return;
    await setTransport({
      command: "set-timing-mode",
      timingMode: "fast-forward"
    });
    timingMode = "fast-forward";
  };

  const installProviderTarget = async (checkpointIndex) => {
    const checkpoint = input.checkpoints[checkpointIndex];
    await setTransport({
      command: "set-provider-cursor",
      providerConnections: checkpoint.cursor.providerConnections
    });
    targetDeadline = Date.now() + input.timeoutMs;
  };

  const compareProviderPosition = (left, right) =>
    left.chunkSeq === right.chunkSeq
      ? left.unitIndex - right.unitIndex
      : left.chunkSeq - right.chunkSeq;

  const providerTargetState = (checkpoint, state) => {
    const current = new Map(
      state.providerConnections.map((position) => [
        position.connectionId,
        position
      ])
    );
    let reached = true;
    for (const target of checkpoint.cursor.providerConnections) {
      const position = current.get(target.connectionId);
      if (!position || compareProviderPosition(position, target) < 0) {
        reached = false;
        continue;
      }
      if (compareProviderPosition(position, target) > 0) {
        throw new Error(
          `checkpoint_provider_overshot: ${checkpoint.id} ${target.connectionId}`
        );
      }
    }
    return reached;
  };

  const verifySemanticCheckpoint = async (checkpointIndex) => {
    const response = await fetch(
      `${input.baseURL}${checkpointVerificationPath(checkpointIndex)}`,
      {
        method: "POST",
        headers: input.headers,
        signal: AbortSignal.timeout(input.timeoutMs)
      }
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `replay checkpoint verification failed with ${response.status}: ${body}`
      );
    }
    const state = JSON.parse(body);
    if (
      state.checkpointIndex !== checkpointIndex ||
      typeof state.triggerMatched !== "boolean" ||
      typeof state.readinessSatisfied !== "boolean" ||
      !Number.isSafeInteger(state.canonicalSessionUpdatedAtUnixMs) ||
      state.canonicalSessionUpdatedAtUnixMs < 0 ||
      !Number.isSafeInteger(state.canonicalMessageVersion) ||
      state.canonicalMessageVersion < 0
    ) {
      throw new Error("replay checkpoint verification state is invalid");
    }
    return state;
  };

  const reconcileTarget = async () => {
    if (targetCheckpoint === null) return;
    const checkpoint = input.checkpoints[targetCheckpoint];
    if (activityEventSequence > checkpoint.cursor.activityEventSequence) {
      throw new Error(`checkpoint_activity_overshot: ${checkpoint.id}`);
    }
    if (activityEventSequence < checkpoint.cursor.activityEventSequence) return;
    const state = await readTransportPlayback();
    if (!providerTargetState(checkpoint, state)) {
      if (targetDeadline !== null && Date.now() >= targetDeadline) {
        throw new Error(`checkpoint_readiness_timeout: ${checkpoint.id}`);
      }
      return;
    }
    const semantic = await verifySemanticCheckpoint(targetCheckpoint);
    if (!semantic.triggerMatched || !semantic.readinessSatisfied) {
      if (targetDeadline !== null && Date.now() >= targetDeadline) {
        throw new Error(`checkpoint_readiness_timeout: ${checkpoint.id}`);
      }
      return;
    }
    currentCheckpoint = targetCheckpoint;
    await setRealtime();
    await input.waitForInspectable?.(checkpoint, semantic);
    await input.onCheckpoint?.(currentCheckpoint);
    if (automatic && currentCheckpoint < input.checkpoints.length - 1) {
      targetCheckpoint = currentCheckpoint + 1;
      await installProviderTarget(targetCheckpoint);
      await setFastForward();
      paused = false;
    } else if (automatic || input.resumeAfterTarget) {
      await setTransport({ command: "clear-provider-cursor" });
      paused = false;
      targetCheckpoint = null;
      targetDeadline = null;
    } else {
      await setTransport({ command: "pause" });
      paused = true;
      targetCheckpoint = null;
      targetDeadline = null;
    }
    await updateStatus();
  };

  const reachBootstrap = async () => {
    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const semantic = await verifySemanticCheckpoint(0);
      if (semantic.triggerMatched && semantic.readinessSatisfied) {
        await input.waitForInspectable?.(input.checkpoints[0], semantic);
        await input.onCheckpoint?.(0);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `checkpoint_readiness_timeout: ${input.checkpoints[0].id}`
        );
      }
      await delay(25);
    }
  };

  const applyControl = async () => {
    if (!input.controlPath) return;
    let document;
    try {
      document = JSON.parse(await readFile(input.controlPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(
        `replay control is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      document?.schemaVersion !== 2 ||
      !document.cassettes ||
      typeof document.cassettes !== "object" ||
      Array.isArray(document.cassettes)
    ) {
      throw new Error("replay control router is invalid");
    }
    const control = document.cassettes[cassetteId];
    if (control == null) return;
    if (typeof control !== "object" || Array.isArray(control)) {
      throw new Error("replay cassette control is invalid");
    }
    if (control.revision === lastRevision) return;
    if (
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
        targetDeadline = null;
        break;
      case "resume":
        await setRealtime();
        await setTransport({ command: "clear-provider-cursor" });
        await setTransport({ command: "resume" });
        paused = false;
        targetCheckpoint = null;
        targetDeadline = null;
        break;
      case "next-checkpoint":
        // Ignore duplicate next while already seeking; only ack the revision.
        if (targetCheckpoint === null) {
          targetCheckpoint = Math.min(
            currentCheckpoint + 1,
            input.checkpoints.length - 1
          );
          if (targetCheckpoint > currentCheckpoint) {
            await installProviderTarget(targetCheckpoint);
            await setFastForward();
            await setTransport({ command: "resume" });
            paused = false;
          } else {
            targetCheckpoint = null;
          }
        }
        break;
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
      if (targetCheckpoint !== 0 && input.verifyBootstrap) {
        await reachBootstrap();
      }
      if (targetCheckpoint === 0) {
        await setTransport({ command: "pause" });
        paused = true;
        targetCheckpoint = null;
        targetDeadline = null;
        await reachBootstrap();
      } else if (targetCheckpoint !== null) {
        await installProviderTarget(targetCheckpoint);
        await setFastForward();
        await setTransport({ command: "resume" });
      }
      await updateStatus();
    },
    async reach(checkpoint) {
      if (checkpoint.index === targetCheckpoint) await reconcileTarget();
    },
    async waitBeforeActivity(sequence) {
      // Hold activity while paused after an inspectable land, and while seeking
      // to a checkpoint whose activity cursor has not yet authorized this
      // sequence. Clearing targetCheckpoint on land must not release the next
      // recorded stimulus (for example an approval response) before the user
      // next/resumes again.
      while (true) {
        await reconcileTarget();
        await applyControl();
        const blockedByTarget =
          targetCheckpoint !== null &&
          sequence >
            input.checkpoints[targetCheckpoint].cursor.activityEventSequence;
        if (!paused && !blockedByTarget) return;
        await delay(25);
      }
    },
    async waitUntilRunnable() {
      while (true) {
        await reconcileTarget();
        await activityClock.synchronize();
        if (!paused) return;
        await delay(50);
      }
    },
    async activityAdvanced(sequence) {
      activityEventSequence = sequence;
      await reconcileTarget();
    },
    async waitForAllCheckpoints() {
      while (currentCheckpoint < input.checkpoints.length - 1) {
        await reconcileTarget();
        await delay(25);
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
    super("Replay Cassette replacement requested");
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
    case "plan.decision":
      return status === 404 || status === 409;
    default:
      return false;
  }
}

async function replayTransportFailure(baseURL, headers, cassetteId, timeoutMs) {
  try {
    const response = await fetch(
      `${baseURL}/v1/agent-session-replay/cassettes/${encodeURIComponent(cassetteId)}/transport/verify`,
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

function requiredReplayCassetteId(value) {
  const cassetteId = typeof value === "string" ? value.trim() : "";
  if (!cassetteId) {
    throw new Error("Replay Cassette id is required");
  }
  return cassetteId;
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
          ...(stimulus.payload.clientSubmitId
            ? { clientSubmitId: stimulus.payload.clientSubmitId }
            : {}),
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

async function waitForPendingReplayInteraction(
  baseURL,
  headers,
  event,
  timeoutMs,
  playback
) {
  let remainingMs = timeoutMs;
  let latest = null;
  while (remainingMs > 0) {
    await playback?.waitUntilRunnable();
    const pollStartedAt = Date.now();
    const response = await fetch(
      `${baseURL}/v1/workspaces/${encodeURIComponent(event.workspaceId)}/agent-sessions/${encodeURIComponent(event.agentSessionId)}`,
      { headers }
    );
    if (response.ok) {
      latest = await response.json();
      const interaction = replayPendingInteraction(
        latest.session ?? latest,
        event.payload.requestId
      );
      if (interaction) {
        return {
          ...event,
          payload: {
            ...event.payload,
            turnId: interaction.turnId
          }
        };
      }
    }
    await delay(100);
    remainingMs -= Date.now() - pollStartedAt;
  }
  throw new Error(
    `timed out waiting for replay Interaction ${event.payload.requestId}: ${JSON.stringify(latest)}`
  );
}

export function replayPendingInteraction(session, requestId) {
  const interactions = Array.isArray(session?.pendingInteractions)
    ? session.pendingInteractions
    : [];
  return (
    interactions.find(
      (interaction) =>
        interaction?.requestId === requestId &&
        interaction?.status === "pending" &&
        typeof interaction?.turnId === "string" &&
        interaction.turnId.trim()
    ) ?? null
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
  timeoutMs,
  cassetteName
) {
  const listener = JSON.parse(
    await readFile(replayListenerInfoPath(stateDirectory), "utf8")
  );
  const headers = {
    authorization: `Bearer ${listener.auth.token}`,
    "content-type": "application/json"
  };
  const baseURL = `http://${listener.addr}/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-session-recordings`;
  const active = (
    await listSessionRecordings(baseURL, headers, timeoutMs)
  ).filter((recording) =>
    ["preparing", "ready", "recording", "finalizing"].includes(recording.status)
  );
  if (active.length !== 1) {
    throw new Error(
      `expected one active Agent Session recording, found ${active.length}`
    );
  }
  const recording = active[0];
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
  if (result.result.value !== true) {
    return completeSessionRecordingViaApi(
      baseURL,
      headers,
      recording.id,
      cassetteName,
      timeoutMs
    );
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let sawFinalizing = false;
  while (Date.now() < deadline) {
    const current = (
      await listSessionRecordings(baseURL, headers, timeoutMs)
    ).find((candidate) => candidate.id === recording.id);
    if (current?.status === "complete") {
      return cassetteName
        ? renameSessionRecording(
            baseURL,
            headers,
            current.id,
            cassetteName,
            timeoutMs
          )
        : current;
    }
    if (current?.status === "finalizing") {
      sawFinalizing = true;
    }
    if (["failed", "canceled", "incomplete"].includes(current?.status)) {
      throw new Error(
        `Agent Session recording ${recording.id} ended as ${current.status}: ${current.errorMessage ?? ""}`
      );
    }
    // UI stop seals activity events before calling complete. If seal fails, the
    // recording stays in "recording" forever; fall back to the HTTP complete API
    // after a short grace period so the runner surfaces a real finalize error.
    if (
      !sawFinalizing &&
      current?.status === "recording" &&
      Date.now() - startedAt >= 15_000
    ) {
      return completeSessionRecordingViaApi(
        baseURL,
        headers,
        recording.id,
        cassetteName,
        timeoutMs
      );
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for Agent Session recording ${recording.id} to complete`
  );
}

async function completeSessionRecordingViaApi(
  baseURL,
  headers,
  recordingId,
  cassetteName,
  timeoutMs
) {
  const response = await fetch(
    `${baseURL}/${encodeURIComponent(recordingId)}/complete`,
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
  const completed = JSON.parse(body);
  return cassetteName
    ? renameSessionRecording(
        baseURL,
        headers,
        completed.id,
        cassetteName,
        timeoutMs
      )
    : completed;
}

async function renameSessionRecording(
  baseURL,
  headers,
  recordingId,
  name,
  timeoutMs
) {
  const response = await fetch(
    `${baseURL}/${encodeURIComponent(recordingId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `rename Agent Session recording failed with ${response.status}: ${body}`
    );
  }
  return JSON.parse(body);
}

async function listSessionRecordings(baseURL, headers, timeoutMs) {
  const response = await fetch(baseURL, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `list Agent Session recordings failed with ${response.status}: ${body}`
    );
  }
  return JSON.parse(body).recordings;
}

async function prepareAgentSessionSurface(client, action, timeoutMs) {
  await prepareAgentSessionTarget(client, action, timeoutMs);
  if (action.type === "continue-session") {
    await activateExistingReplaySessionSurface(client, action, timeoutMs);
  }
  await waitForIdleAgentComposer(client, timeoutMs);
}

async function waitForIdleAgentComposer(client, timeoutMs) {
  await waitForEvaluation(
    client,
    `(() => {
      const editor = document.querySelector('[data-testid="agent-gui-composer-editor"]');
      const stop = document.querySelector('[data-testid="agent-gui-composer-stop-active-turn"]');
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
  // Dock launch can silently no-op while agent targets / provider probes are
  // still hydrating (onLaunchRequest returns null). Retry until the rail
  // appears instead of clicking once and waiting forever.
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await evaluate(
      client,
      `(() => {
        const target = [...document.querySelectorAll('[data-provider-target-id]')]
          .find((element) => element.dataset.providerTargetId === ${JSON.stringify(action.agentTargetId)});
        if (
          target instanceof HTMLButtonElement &&
          !target.disabled &&
          target.dataset.disabled !== 'true'
        ) {
          return { ready: true };
        }
        const dock = document.querySelector(
          '[data-desktop-dock-anchor-key="agent-gui:unified"] button'
        );
        if (!(dock instanceof HTMLButtonElement)) {
          return { ready: false, reason: 'dock-unavailable' };
        }
        dock.click();
        return { ready: false, reason: 'dock-clicked' };
      })()`
    );
    if (latest?.ready) {
      break;
    }
    await delay(1_000);
  }
  if (!latest?.ready) {
    throw new Error(
      `timed out waiting for enabled Agent target ${action.agentTargetId}: ${JSON.stringify(latest)}`
    );
  }
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
  await prepareAgentSessionTarget(client, action, timeoutMs);
  await activateExistingReplaySessionSurface(client, action, timeoutMs);
}

async function startReplayProjectSession(client, projectId, timeoutMs) {
  const testId = `agent-gui-project-${projectId}-new-session`;
  await waitForEvaluation(
    client,
    `(() => {
      const button = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
      return { ready: button instanceof HTMLElement };
    })()`,
    timeoutMs,
    `project session action ${projectId}`
  );
  await evaluate(
    client,
    `(() => {
      const button = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
      if (!(button instanceof HTMLElement)) {
        throw new Error(${JSON.stringify(`${testId} is unavailable`)});
      }
      button.click();
      return true;
    })()`
  );
  await waitForEvaluation(
    client,
    `(() => {
      const shell = document.querySelector('[data-testid="agent-gui-composer-input-shell"]');
      return {
        ready:
          shell instanceof HTMLElement &&
          shell.dataset.inputDisabled !== 'true'
      };
    })()`,
    timeoutMs,
    "project session composer",
    25
  );
}

async function focusReplaySessionDetailSurface(client, action, timeoutMs) {
  await prepareAgentSessionTarget(client, action, timeoutMs);
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
  const alreadyActive = await evaluate(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-testid="agent-gui-conversation-item-${action.agentSessionId}"]`)});
      return row?.dataset.active === 'true';
    })()`
  );
  if (!alreadyActive) {
    await clickSession(client, action.agentSessionId);
  }
  await waitForActiveSession(client, action.agentSessionId, timeoutMs);
  await waitForEvaluation(
    client,
    `(() => {
      const detail = document.querySelector(${JSON.stringify(
        `main[data-agent-session-id="${action.agentSessionId}"]`
      )});
      return { ready: Boolean(detail) };
    })()`,
    timeoutMs,
    `Agent session detail ${action.agentSessionId}`
  );
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

export function normalizeScreenshotClip(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = Math.max(0, Math.floor(Number(rect.x)));
  const y = Math.max(0, Math.floor(Number(rect.y)));
  const width = Math.floor(Number(rect.width));
  const height = Math.floor(Number(rect.height));
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 8 ||
    height < 8
  ) {
    return null;
  }
  return { x, y, width, height, scale: 1 };
}

export function screenshotEvidenceLabel(source) {
  if (typeof source === "string") {
    return source.trim();
  }
  if (!source || typeof source !== "object") return "";
  for (const key of ["caseId", "screenshotLabel", "scenario", "label"]) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export async function resolveAgentSessionScreenshotClip(
  client,
  agentSessionId
) {
  const pinned =
    typeof agentSessionId === "string" ? agentSessionId.trim() : "";
  if (!pinned) return null;
  const rect = await evaluate(
    client,
    `(() => {
      const id = ${JSON.stringify(pinned)};
      const detail = [...document.querySelectorAll('main[data-agent-session-id]')].find(
        (candidate) => candidate.getAttribute('data-agent-session-id') === id
      );
      if (!(detail instanceof HTMLElement)) return null;
      const shell =
        detail.closest('[data-workbench-window-id]') instanceof HTMLElement
          ? detail.closest('[data-workbench-window-id]')
          : detail;
      const box = shell.getBoundingClientRect();
      const x = Math.max(0, box.left);
      const y = Math.max(0, box.top);
      const right = Math.min(window.innerWidth, box.right);
      const bottom = Math.min(window.innerHeight, box.bottom);
      return {
        x,
        y,
        width: right - x,
        height: bottom - y
      };
    })()`
  );
  return normalizeScreenshotClip(rect);
}

async function installEvidenceBadge(client, { agentSessionId, label }) {
  const text = screenshotEvidenceLabel(label);
  if (!text) return false;
  const pinned =
    typeof agentSessionId === "string" ? agentSessionId.trim() : "";
  await evaluate(
    client,
    `(() => {
      const text = ${JSON.stringify(text)};
      const id = ${JSON.stringify(pinned)};
      document
        .querySelectorAll('[data-tutti-replay-evidence-badge="true"]')
        .forEach((node) => node.remove());
      const detail = id
        ? [...document.querySelectorAll('main[data-agent-session-id]')].find(
            (candidate) => candidate.getAttribute('data-agent-session-id') === id
          )
        : null;
      const host =
        (detail instanceof HTMLElement &&
          detail.closest('[data-workbench-window-id]')) ||
        detail ||
        document.documentElement;
      if (!(host instanceof HTMLElement)) return false;
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
      }
      const badge = document.createElement('div');
      badge.setAttribute('data-tutti-replay-evidence-badge', 'true');
      badge.textContent = text;
      badge.style.cssText = [
        'position:absolute',
        'top:8px',
        'left:8px',
        'z-index:2147483647',
        'pointer-events:none',
        'box-sizing:border-box',
        'padding:4px 10px',
        'border-radius:4px',
        'background:#111827',
        'color:#f8fafc',
        'font:700 14px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
        'letter-spacing:0.02em',
        'box-shadow:0 1px 4px rgba(0,0,0,.45)'
      ].join(';');
      host.appendChild(badge);
      return true;
    })()`
  );
  return true;
}

async function removeEvidenceBadge(client) {
  try {
    await evaluate(
      client,
      `(() => {
        document
          .querySelectorAll('[data-tutti-replay-evidence-badge="true"]')
          .forEach((node) => node.remove());
        return true;
      })()`
    );
  } catch {
    // Best-effort cleanup; capture already completed or page is gone.
  }
}

const PINNED_PAINTED_DETAIL_EXPRESSION = `(function resolvePinnedPaintedDetail(sessionId) {
  const isPaintedAtCenter = (candidate) => {
    if (!(candidate instanceof HTMLElement) || candidate.offsetParent === null) {
      return false;
    }
    const rect = candidate.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= window.innerWidth ||
      rect.top >= window.innerHeight
    ) {
      return false;
    }
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    return document.elementsFromPoint(x, y).some(
      (element) => element === candidate || candidate.contains(element)
    );
  };
  const matches = [...document.querySelectorAll('main[data-agent-session-id]')].filter(
    (candidate) => candidate.getAttribute('data-agent-session-id') === sessionId
  );
  return (
    matches.find((candidate) => isPaintedAtCenter(candidate)) ||
    matches.find((candidate) => {
      if (!(candidate instanceof HTMLElement) || candidate.offsetParent === null) {
        return false;
      }
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) ||
    null
  );
})`;

async function startToolEvidenceExpandKeepAlive(client, agentSessionId) {
  const pinned =
    typeof agentSessionId === "string" ? agentSessionId.trim() : "";
  if (!pinned) return false;
  // Runner-injected only: keep re-clicking collapsed chrome every frame so
  // virtualizer remounts cannot leave a collapsed frame for the PNG.
  return evaluate(
    client,
    `(() => {
      const id = ${JSON.stringify(pinned)};
      const resolvePinnedPaintedDetail = ${PINNED_PAINTED_DETAIL_EXPRESSION};
      globalThis.__tuttiToolEvidenceExpandKeepAlive = true;
      globalThis.__tuttiToolEvidenceExpandSessionId = id;
      if (globalThis.__tuttiToolEvidenceExpandRaf != null) {
        return true;
      }
      const clickCollapsed = (nodes) => {
        for (const node of nodes) {
          if (!(node instanceof HTMLButtonElement)) continue;
          if (node.getAttribute('aria-expanded') === 'true') continue;
          node.click();
        }
      };
      const tick = () => {
        if (globalThis.__tuttiToolEvidenceExpandKeepAlive !== true) {
          globalThis.__tuttiToolEvidenceExpandRaf = null;
          return;
        }
        const detail = resolvePinnedPaintedDetail(
          globalThis.__tuttiToolEvidenceExpandSessionId
        );
        if (detail instanceof HTMLElement) {
          clickCollapsed([
            ...detail.querySelectorAll(
              '[data-agent-turn-work-header] button[aria-expanded]'
            )
          ]);
          clickCollapsed([
            ...detail.querySelectorAll(
              'button.workspace-agents-status-panel__detail-tool-count[aria-expanded]'
            )
          ]);
          clickCollapsed([
            ...detail.querySelectorAll(
              'button.workspace-agents-status-panel__detail-tool-row-head--button'
            )
          ]);
        }
        globalThis.__tuttiToolEvidenceExpandRaf = requestAnimationFrame(tick);
      };
      globalThis.__tuttiToolEvidenceExpandRaf = requestAnimationFrame(tick);
      return true;
    })()`
  );
}

async function stopToolEvidenceExpandKeepAlive(client) {
  try {
    await evaluate(
      client,
      `(() => {
        globalThis.__tuttiToolEvidenceExpandKeepAlive = false;
        if (globalThis.__tuttiToolEvidenceExpandRaf != null) {
          cancelAnimationFrame(globalThis.__tuttiToolEvidenceExpandRaf);
          globalThis.__tuttiToolEvidenceExpandRaf = null;
        }
        delete globalThis.__tuttiToolEvidenceExpandSessionId;
        return true;
      })()`
    );
  } catch {
    // Best-effort cleanup after capture.
  }
}

export async function captureScreenshot(client, outputPath, options = {}) {
  const agentSessionId =
    typeof options.agentSessionId === "string"
      ? options.agentSessionId.trim()
      : "";
  const label = screenshotEvidenceLabel(options.label ?? options);
  const expandToolEvidence = Boolean(
    options.expandToolEvidence && agentSessionId
  );
  const captureOnce = async (clip) => {
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      ...(clip ? { clip } : {})
    });
    if (!result.data) {
      throw new Error("CDP screenshot returned no data");
    }
    return { clip, data: result.data };
  };

  if (!expandToolEvidence) {
    const badgeInstalled = await installEvidenceBadge(client, {
      agentSessionId,
      label
    });
    try {
      const clip = agentSessionId
        ? await resolveAgentSessionScreenshotClip(client, agentSessionId)
        : null;
      const { data } = await captureOnce(clip);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from(data, "base64"));
      return { clip, outputPath };
    } finally {
      if (badgeInstalled) {
        await removeEvidenceBadge(client);
      }
    }
  }

  // Expand → capture → verify. Remounts can collapse between settle and PNG;
  // a runner-side rAF keep-alive re-opens chrome without touching AGUI source.
  await startToolEvidenceExpandKeepAlive(client, agentSessionId);
  try {
    await prepareToolEvidenceForScreenshot(client, agentSessionId);
    const badgeInstalled = await installEvidenceBadge(client, {
      agentSessionId,
      label
    });
    try {
      const clip = await resolveAgentSessionScreenshotClip(
        client,
        agentSessionId
      );
      const deadline = Date.now() + 5_000;
      let lastInspect = null;
      while (Date.now() < deadline) {
        // Expand + paint-check in one evaluate, then capture with no other awaits.
        lastInspect = await evaluate(
          client,
          `(() => {
            const id = ${JSON.stringify(agentSessionId)};
            const resolvePinnedPaintedDetail = ${PINNED_PAINTED_DETAIL_EXPRESSION};
            const detail = resolvePinnedPaintedDetail(id);
            if (!(detail instanceof HTMLElement)) {
              return { ready: false, reason: 'pinned-detail-missing' };
            }
            const clickCollapsed = (nodes) => {
              for (const node of nodes) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.getAttribute('aria-expanded') === 'true') continue;
                if (typeof node.click === 'function') node.click();
              }
            };
            clickCollapsed([
              ...detail.querySelectorAll(
                '[data-agent-turn-work-header] button[aria-expanded], [data-agent-turn-work-header] [aria-expanded]'
              )
            ]);
            clickCollapsed([
              ...detail.querySelectorAll(
                'button.workspace-agents-status-panel__detail-tool-count[aria-expanded]'
              )
            ]);
            clickCollapsed([
              ...detail.querySelectorAll(
                'button.workspace-agents-status-panel__detail-tool-row-head--button'
              )
            ]);
            const groups = [
              ...detail.querySelectorAll(
                'button.workspace-agents-status-panel__detail-tool-count[aria-expanded]'
              )
            ];
            const heads = [
              ...detail.querySelectorAll(
                'button.workspace-agents-status-panel__detail-tool-row-head--button'
              )
            ];
            // No tool chrome yet (or this turn has none): do not block capture.
            if (groups.length === 0 && heads.length === 0) {
              return {
                ready: true,
                reason: 'no-tool-chrome',
                commandVisible: false,
                commandText: '',
                commandRect: null,
                toolDetailTextVisible: false,
                openToolRevealCount: 0,
                groupExpanded: [],
                headExpanded: [],
                dpr: window.devicePixelRatio,
                viewport: { width: window.innerWidth, height: window.innerHeight }
              };
            }
            const isPaintedElement = (element) => {
              if (!(element instanceof HTMLElement) || element.offsetParent === null) {
                return false;
              }
              const rect = element.getBoundingClientRect();
              if (rect.height < 8 || rect.width < 8) return false;
              if (
                rect.bottom <= 0 ||
                rect.top >= window.innerHeight ||
                rect.right <= 0 ||
                rect.left >= window.innerWidth
              ) {
                return false;
              }
              const x = Math.min(
                window.innerWidth - 1,
                Math.max(0, rect.left + rect.width / 2)
              );
              const y = Math.min(
                window.innerHeight - 1,
                Math.max(0, rect.top + rect.height / 2)
              );
              return document.elementsFromPoint(x, y).some(
                (node) =>
                  node === element ||
                  element.contains(node) ||
                  node.contains?.(element)
              );
            };
            const openRowReveals = [
              ...detail.querySelectorAll(
                '.workspace-agents-status-panel__detail-tool-row .agent-collapsible-reveal[data-expanded="true"]'
              )
            ].filter((reveal) => isPaintedElement(reveal));
            const commands = [
              ...detail.querySelectorAll('[data-agent-terminal-command="true"]')
            ];
            const visibleCommand = commands.find((element) => {
              if (!isPaintedElement(element)) return false;
              return (element.textContent ?? '').trim().length > 0;
            });
            const commandVisible = Boolean(visibleCommand);
            const toolDetailTextVisible = openRowReveals.some((reveal) => {
              const text = (reveal.textContent ?? '').trim();
              return text.length > 12;
            });
            return {
              ready: commandVisible || toolDetailTextVisible,
              reason:
                commandVisible || toolDetailTextVisible
                  ? 'tool-body-painted'
                  : 'tool-body-not-painted',
              commandVisible,
              commandText: (visibleCommand?.textContent ?? '').trim().slice(0, 80),
              commandRect: visibleCommand
                ? (() => {
                    const rect = visibleCommand.getBoundingClientRect();
                    return {
                      x: rect.x,
                      y: rect.y,
                      width: rect.width,
                      height: rect.height
                    };
                  })()
                : null,
              toolDetailTextVisible,
              openToolRevealCount: openRowReveals.length,
              groupExpanded: groups.map((group) =>
                group.getAttribute('aria-expanded')
              ),
              headExpanded: heads.map((head) =>
                head.getAttribute('aria-expanded')
              ),
              dpr: window.devicePixelRatio,
              viewport: { width: window.innerWidth, height: window.innerHeight }
            };
          })()`
        );
        if (!lastInspect?.ready) {
          await delay(25);
          continue;
        }
        const { data } = await captureOnce(clip);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.from(data, "base64"));
        return { clip, outputPath };
      }
      throw new Error(
        `timed out capturing expanded tool evidence: ${JSON.stringify(lastInspect)}`
      );
    } finally {
      if (badgeInstalled) {
        await removeEvidenceBadge(client);
      }
    }
  } finally {
    await stopToolEvidenceExpandKeepAlive(client);
  }
}

export function replayCheckpointScreenshotPath({
  artifactDirectory,
  cassetteId,
  checkpointIndex,
  checkpoints
}) {
  if (
    typeof artifactDirectory !== "string" ||
    artifactDirectory.trim() === ""
  ) {
    throw new Error("checkpoint screenshot artifact directory is required");
  }
  if (!Number.isSafeInteger(checkpointIndex) || checkpointIndex < 0) {
    throw new Error(
      `checkpoint screenshot index is invalid: ${checkpointIndex}`
    );
  }
  const checkpoint = Array.isArray(checkpoints)
    ? checkpoints[checkpointIndex]
    : null;
  const id =
    typeof checkpoint?.id === "string" && checkpoint.id.trim()
      ? checkpoint.id.trim()
      : `checkpoint-${String(checkpointIndex).padStart(4, "0")}`;
  const scope =
    typeof cassetteId === "string" && cassetteId.trim()
      ? cassetteId.trim()
      : "";
  return scope
    ? join(artifactDirectory, scope, `${id}.png`)
    : join(artifactDirectory, `${id}.png`);
}

export async function captureCheckpointScreenshot({
  agentSessionId,
  artifactDirectory,
  cassetteId,
  checkpointIndex,
  checkpoints,
  client,
  label,
  prepareToolEvidence = false
}) {
  const outputPath = replayCheckpointScreenshotPath({
    artifactDirectory,
    cassetteId,
    checkpointIndex,
    checkpoints
  });
  const expandToolEvidence = Boolean(prepareToolEvidence && agentSessionId);
  await captureScreenshot(client, outputPath, {
    agentSessionId,
    expandToolEvidence,
    label
  });
  log(`checkpoint screenshot: ${outputPath}`);
  return outputPath;
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

// startDesktop treats any non-false value as headless. Normalize CLI options so
// omitting --headless shows a window; only an explicit --headless hides it.
// Managed replay always stays headed so the user can inspect the surface.
export function resolveDesktopHeadless(options) {
  if (options.managed) return false;
  return options.headless === true;
}

export function parseArgs(argv) {
  const options = {
    stallTimeoutMs: defaultStallTimeoutMs,
    timeoutMs: defaultTimeoutMs
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--record") {
      setMode(options, "record", requiredValue(argv, (index += 1), arg));
    } else if (arg === "--ui-drive") {
      setMode(options, "ui-drive", requiredValue(argv, (index += 1), arg));
    } else if (arg === "--replay") {
      setMode(options, "replay", requiredValue(argv, (index += 1), arg));
    } else if (arg === "--replay-workspace-manifest") {
      if (options.mode) {
        throw new Error("choose exactly one replay or record mode");
      }
      options.mode = "replay-workspace";
      options.replayWorkspaceManifestPath = resolve(
        requiredValue(argv, (index += 1), arg)
      );
    } else if (arg === "--scenario") {
      options.scenario = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--scenario-file") {
      options.scenarioFile = resolve(requiredValue(argv, (index += 1), arg));
    } else if (arg === "--agent-target-id") {
      options.agentTargetId = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveNumber(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--stall-timeout-ms") {
      options.stallTimeoutMs = nonNegativeInteger(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--headless") {
      options.headless = true;
    } else if (arg === "--managed") {
      options.managed = true;
    } else if (arg === "--cassette-id") {
      options.cassetteId = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--target-checkpoint") {
      options.targetCheckpoint = nonNegativeInteger(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--keep-runtime") {
      options.keepRuntime = true;
    } else if (arg === "--screenshot-checkpoints") {
      options.screenshotCheckpoints = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.help && !options.mode) {
    throw new Error("choose exactly one of --record, --replay, or --ui-drive");
  }
  if (
    options.screenshotCheckpoints &&
    options.mode !== "replay" &&
    options.mode !== "replay-workspace"
  ) {
    throw new Error("--screenshot-checkpoints is only supported with replay");
  }
  if (
    options.managed &&
    options.mode !== "replay" &&
    options.mode !== "replay-workspace"
  ) {
    throw new Error("--managed is only supported with replay");
  }
  if (options.managed && options.mode === "replay" && !options.cassetteId) {
    throw new Error("--cassette-id is required with --managed");
  }
  if (options.mode === "replay-workspace" && options.cassetteId) {
    throw new Error("--cassette-id is not supported with a Replay Workspace");
  }
  if (options.mode === "replay-workspace" && options.targetCheckpoint != null) {
    throw new Error(
      "--target-checkpoint is not supported with a Replay Workspace"
    );
  }
  if (
    options.agentTargetId &&
    options.mode !== "record" &&
    options.mode !== "ui-drive"
  ) {
    throw new Error(
      "--agent-target-id is only supported with record or --ui-drive"
    );
  }
  if (
    options.scenario &&
    options.mode !== "record" &&
    options.mode !== "replay" &&
    options.mode !== "replay-workspace" &&
    options.mode !== "ui-drive"
  ) {
    throw new Error(
      "--scenario is only supported with record, replay, replay-workspace, or --ui-drive"
    );
  }
  if (
    options.scenarioFile &&
    options.mode !== "record" &&
    options.mode !== "replay" &&
    options.mode !== "replay-workspace" &&
    options.mode !== "ui-drive"
  ) {
    throw new Error(
      "--scenario-file is only supported with record, replay, replay-workspace, or --ui-drive"
    );
  }
  if (
    (options.scenario && !options.scenarioFile) ||
    (!options.scenario && options.scenarioFile)
  ) {
    throw new Error("--scenario and --scenario-file must be provided together");
  }
  if (options.mode === "record" && !options.scenario) {
    throw new Error("--scenario is required with --record");
  }
  if (options.mode === "record" && !options.scenarioFile) {
    throw new Error("--scenario-file is required with --record");
  }
  if (options.mode === "ui-drive" && !options.scenario) {
    throw new Error("--scenario is required with --ui-drive");
  }
  if (options.mode === "ui-drive" && !options.scenarioFile) {
    throw new Error("--scenario-file is required with --ui-drive");
  }
  return options;
}

export async function loadRecordScenario(options) {
  const module = await import(pathToFileURL(options.scenarioFile).href);
  const scenario = module.default;
  if (
    !scenario ||
    scenario.id !== options.scenario ||
    typeof scenario.prepare !== "function" ||
    typeof scenario.drive !== "function" ||
    typeof scenario.assert !== "function"
  ) {
    throw new Error(
      `record scenario file does not export scenario ${options.scenario}: ${options.scenarioFile}`
    );
  }
  if (
    scenario.settleForScreenshot !== undefined &&
    typeof scenario.settleForScreenshot !== "function"
  ) {
    throw new Error(
      `record scenario ${options.scenario} has invalid settleForScreenshot`
    );
  }
  return scenario;
}

export function checkpointNeedsToolSettle(checkpoint) {
  if (!checkpoint) return false;
  const kind = String(checkpoint.kind ?? "");
  const tags = Array.isArray(checkpoint.tags) ? checkpoint.tags : [];
  // Forced expanded-tool PNG capture is only meaningful once a tool has
  // completed. tool.started often has no painted body yet (I10/L06 Agent
  // tool); requiring it hard-fails replay with tool-body-not-painted.
  return [kind, ...tags].some((token) =>
    /(?:^|[.])tool\.completed$/u.test(String(token))
  );
}

export function checkpointNeedsScreenshotSettle(checkpoint) {
  if (!checkpoint) return true;
  const kind = String(checkpoint.kind ?? "");
  const tags = Array.isArray(checkpoint.tags) ? checkpoint.tags : [];
  return [kind, ...tags].some((token) =>
    /(?:^|[.])(?:tool\.completed|tool\.started|turn\.terminal|turn\.completed)$/u.test(
      String(token)
    )
  );
}

export function checkpointAllowsOptionalScreenshotSettle(checkpoint) {
  if (!checkpoint) return false;
  const kind = String(checkpoint.kind ?? "");
  const tags = Array.isArray(checkpoint.tags) ? checkpoint.tags : [];
  // Queue cases soft-wait for the composer blue bar on busy-queue submits.
  // Do not fold this into checkpointNeedsScreenshotSettle: tool-evidence
  // settlers (I10/L06/R*) would hang for the full timeout when no tool chrome
  // exists yet at submission.accepted.
  return [kind, ...tags].some((token) =>
    /(?:^|[.])submission\.accepted$/u.test(String(token))
  );
}

export function scenarioPreparesToolEvidence(scenario) {
  return typeof scenario?.settleForScreenshot === "function";
}

export async function maybeSettleForScreenshot(
  scenario,
  client,
  timeoutMs,
  checkpoint = null,
  agentSessionId = null
) {
  if (!scenario || typeof scenario.settleForScreenshot !== "function") {
    return;
  }
  if (
    checkpoint &&
    !checkpointNeedsScreenshotSettle(checkpoint) &&
    !checkpointAllowsOptionalScreenshotSettle(checkpoint)
  ) {
    return;
  }
  const pinned =
    typeof agentSessionId === "string" && agentSessionId.trim()
      ? agentSessionId.trim()
      : null;
  if (pinned) {
    await evaluate(
      client,
      `globalThis.__tuttiSettleAgentSessionId = ${JSON.stringify(pinned)}; true`
    );
  }
  try {
    await scenario.settleForScreenshot({
      agentSessionId: pinned,
      client,
      timeoutMs,
      checkpoint
    });
  } finally {
    if (pinned) {
      await evaluate(
        client,
        "delete globalThis.__tuttiSettleAgentSessionId; true"
      );
    }
  }
}

export async function prepareToolEvidenceForScreenshot(
  client,
  agentSessionId,
  timeoutMs = 5_000
) {
  const pinned =
    typeof agentSessionId === "string" && agentSessionId.trim()
      ? agentSessionId.trim()
      : null;
  if (!pinned) return null;
  await evaluate(
    client,
    `globalThis.__tuttiSettleAgentSessionId = ${JSON.stringify(pinned)}; true`
  );
  try {
    await waitForEvaluation(
      client,
      `(() => {
        const resolvePinnedPaintedDetail = ${PINNED_PAINTED_DETAIL_EXPRESSION};
        const detail = resolvePinnedPaintedDetail(
          globalThis.__tuttiSettleAgentSessionId
        );
        if (!(detail instanceof HTMLElement)) {
          return { ready: false, reason: 'pinned-detail-missing' };
        }
        const clickCollapsed = (nodes) => {
          for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.getAttribute('aria-expanded') === 'true') continue;
            if (typeof node.click === 'function') node.click();
          }
        };
        const workToggles = [
          ...detail.querySelectorAll(
            '[data-agent-turn-work-header] button[aria-expanded], [data-agent-turn-work-header] [aria-expanded]'
          )
        ];
        const workCollapsed = workToggles.some(
          (toggle) => toggle.getAttribute('aria-expanded') !== 'true'
        );
        clickCollapsed(workToggles);
        // Collapsed turn-work unmounts tool rows; wait a poll after expanding.
        if (workCollapsed) {
          return { ready: false, reason: 'expanding-work' };
        }
        const groups = [
          ...detail.querySelectorAll(
            'button.workspace-agents-status-panel__detail-tool-count[aria-expanded]'
          )
        ];
        const heads = [
          ...detail.querySelectorAll(
            'button.workspace-agents-status-panel__detail-tool-row-head--button'
          )
        ];
        const groupsCollapsed = groups.some(
          (group) => group.getAttribute('aria-expanded') !== 'true'
        );
        clickCollapsed(groups);
        if (groupsCollapsed) {
          return { ready: false, reason: 'expanding-groups' };
        }
        // Heads may mount only after the group reveal opens.
        const headsNow = [
          ...detail.querySelectorAll(
            'button.workspace-agents-status-panel__detail-tool-row-head--button'
          )
        ];
        const headsCollapsed = headsNow.some(
          (head) => head.getAttribute('aria-expanded') !== 'true'
        );
        clickCollapsed(headsNow);
        if (headsCollapsed) {
          return { ready: false, reason: 'expanding-heads' };
        }
        const hasToolChrome = groups.length > 0 || headsNow.length > 0;
        // Text/queue turns never mount tool chrome. Do not wait forever here —
        // that breaks C04 and other non-tool terminal screenshots.
        if (!hasToolChrome) {
          return { ready: true, reason: 'no-tool-chrome', hasToolChrome: false };
        }
        const openRowReveals = [
          ...detail.querySelectorAll(
            '.workspace-agents-status-panel__detail-tool-row .agent-collapsible-reveal[data-expanded="true"]'
          )
        ].filter((reveal) => {
          if (!(reveal instanceof HTMLElement) || reveal.offsetParent === null) {
            return false;
          }
          const rect = reveal.getBoundingClientRect();
          if (rect.height < 8 || rect.width < 8) return false;
          const x = Math.min(
            window.innerWidth - 1,
            Math.max(0, rect.left + rect.width / 2)
          );
          const y = Math.min(
            window.innerHeight - 1,
            Math.max(0, rect.top + rect.height / 2)
          );
          return document.elementsFromPoint(x, y).some(
            (node) =>
              node === reveal || reveal.contains(node) || node.contains?.(reveal)
          );
        });
        const commands = [
          ...detail.querySelectorAll('[data-agent-terminal-command="true"]')
        ];
        const commandVisible = commands.some((element) => {
          if (!(element instanceof HTMLElement) || element.offsetParent === null) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          if (rect.height < 8 || rect.width < 8) return false;
          if (
            rect.bottom <= 0 ||
            rect.top >= window.innerHeight ||
            rect.right <= 0 ||
            rect.left >= window.innerWidth
          ) {
            return false;
          }
          const x = Math.min(
            window.innerWidth - 1,
            Math.max(0, rect.left + rect.width / 2)
          );
          const y = Math.min(
            window.innerHeight - 1,
            Math.max(0, rect.top + rect.height / 2)
          );
          const painted = document.elementsFromPoint(x, y).some(
            (node) =>
              node === element ||
              element.contains(node) ||
              node.contains?.(element)
          );
          if (!painted) return false;
          return (element.textContent ?? '').trim().length > 0;
        });
        const toolDetailTextVisible = openRowReveals.some((reveal) => {
          const text = (reveal.textContent ?? '').trim();
          return text.length > 12;
        });
        return {
          ready: commandVisible || toolDetailTextVisible,
          openToolRevealCount: openRowReveals.length,
          commandVisible,
          toolDetailTextVisible,
          hasToolChrome,
          groupExpanded: groups.map((group) => group.getAttribute('aria-expanded')),
          headExpanded: headsNow.map((head) => head.getAttribute('aria-expanded'))
        };
      })()`,
      timeoutMs,
      "pre-screenshot tool evidence",
      25
    );
  } finally {
    await evaluate(
      client,
      "delete globalThis.__tuttiSettleAgentSessionId; true"
    );
  }
  return null;
}

function setMode(options, mode, directory) {
  if (options.mode) {
    throw new Error("choose exactly one of --record, --replay, or --ui-drive");
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

// Surface the isolated runtime's own diagnostics next to a failure instead of
// asking the operator to locate and open the kept-runtime files manually.
async function logFailureDiagnostics(runtime, tailLines = 15) {
  const candidates = [
    join(runtime.directory, "logs", "desktop.log"),
    join(runtime.stateDirectory, "logs", "tuttid.log")
  ];
  for (const path of candidates) {
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n").filter((line) => line.trim());
    log(`${basename(path)} tail (${path}):`);
    for (const line of lines.slice(-tailLines)) {
      log(`  ${line}`);
    }
  }
}

function printUsage() {
  process.stdout.write(
    `Record and replay an AgentGUI SessionGraph scenario.\n\n` +
      `Usage:\n` +
      `  pnpm e2e:agent-gui -- --record .tmp/cassettes/c01_codex --scenario c01 --scenario-file ../tutti-agent-session-replay-cases/cases/c01/scenario.mjs\n` +
      `  pnpm e2e:agent-gui -- --replay .tmp/cassettes/c01_codex\n` +
      `  pnpm e2e:agent-gui -- --ui-drive .tmp/ui-drive/u01 --scenario u01 --scenario-file ../tutti-agent-session-replay-cases/cases/u01/scenarios/u01.mjs\n` +
      `  pnpm e2e:agent-gui -- --replay-workspace-manifest .tmp/replay-workspace.json\n\n` +
      `Options:\n` +
      `  --record <directory>   Record the required named scenario into a new empty cassette directory\n` +
      `  --ui-drive <directory>  Run a pure-UI scenario with step checkpoints/screenshots (no cassette)\n` +
      `  --replay <directory>   Replay an existing complete cassette\n` +
      `  --replay-workspace-manifest <path> Bootstrap one fixed multi-Cassette Replay Workspace\n` +
      `  --scenario <id>        Required with --record/--ui-drive; optional with replay to settle UI before screenshots\n` +
      `  --scenario-file <path> Required with --record/--ui-drive; optional with replay. ES module exporting the scenario as default\n` +
      `  --agent-target-id <id> Agent Target used for recording/ui-drive. Default: local:codex\n` +
      `  --timeout-ms <n>       Desktop/action timeout. Default: ${defaultTimeoutMs}\n` +
      `  --stall-timeout-ms <n> Fail a wait when its observed value stops changing for n ms; 0 disables. Default: ${defaultStallTimeoutMs}\n` +
      `  --headless             Hide the Electron window (default: show the window)\n` +
      `  --managed              Keep a directly launched replay Electron open until the user closes it\n` +
      `  --cassette-id <id>          Stable managed Replay Cassette identity\n` +
      `  --target-checkpoint <n> Fast-forward a replacement Cassette and pause at checkpoint n\n` +
      `  --screenshot-checkpoints Capture a PNG under artifacts/ after each inspectable checkpoint\n` +
      `  --keep-runtime         Keep the isolated state and Electron userData\n`
  );
}
