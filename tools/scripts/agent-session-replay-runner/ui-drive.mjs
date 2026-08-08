import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CdpClient } from "../capture-electron-trace.mjs";
import {
  configureWaitDiagnostics,
  evaluate,
  selectProvider,
  waitForEvaluation
} from "../agent-gui-performance-helpers.mjs";
import {
  reservePort,
  startDesktop,
  stopProcessTree,
  waitForPageWebSocket
} from "../run-agent-gui-performance.mjs";
import {
  resolveAgentSessionReplayProjectRoot,
  resolveRecordScenarioProject,
  seedRecordingUserProject
} from "./recording.mjs";
import {
  createRuntime,
  enableAgentSessionRecordingFeature,
  enableAgentSessionRecordingTarget,
  initializeCleanDatabase,
  preparedDesktopLaunch,
  removeRuntime,
  setAgentComposerDefaults
} from "./runtime.mjs";
import {
  bindManagedReplayShutdown as bindManagedReplayShutdownCore,
  loadUiScenario,
  managedReplayCheckpointPrefix,
  managedReplayCompletePrefix,
  managedReplayFailedPrefix,
  runUiDriveScenario
} from "../../../packages/agent/session-replay-runner/src/index.mjs";

function bindManagedReplayShutdown(desktop, options = {}) {
  const { stopDesktop = stopProcessTree, ...rest } = options;
  return bindManagedReplayShutdownCore(desktop, {
    ...rest,
    exitOnSignal: rest.exitOnSignal ?? true,
    stopDesktop
  });
}

export const uiDriveCompletePrefix = managedReplayCompletePrefix;
export const uiDriveFailedPrefix = managedReplayFailedPrefix;
export const uiDriveCheckpointPrefix = managedReplayCheckpointPrefix;

export { loadUiScenario };

function log(message) {
  process.stderr.write(`[agent-session-replay] ${message}\n`);
}

async function captureScreenshot(client, outputPath) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function prepareAgentGuiSurface(client, agentTargetId, timeoutMs) {
  await waitForEvaluation(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(agentTargetId)});
      const dock = document.querySelector(
        '[data-desktop-dock-anchor-key="agent-gui:unified"] button'
      );
      return { ready: Boolean(target) || dock instanceof HTMLButtonElement };
    })()`,
    timeoutMs,
    "AgentGUI surface or dock launcher"
  );
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await evaluate(
      client,
      `(() => {
        const target = [...document.querySelectorAll('[data-provider-target-id]')]
          .find((element) => element.dataset.providerTargetId === ${JSON.stringify(agentTargetId)});
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
    if (latest?.ready) break;
    await delay(1_000);
  }
  if (!latest?.ready) {
    throw new Error(
      `timed out waiting for enabled Agent target ${agentTargetId}: ${JSON.stringify(latest)}`
    );
  }
  await selectProvider(client, agentTargetId, timeoutMs);
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

/**
 * Run a pure-UI scenario with step checkpoints (screenshot + programmatic assert).
 * Does not create Session Replay cassettes.
 */
export async function uiDriveScenario(options) {
  const workspaceRoot = options.workspaceRoot;
  const projectRoot = resolveAgentSessionReplayProjectRoot();
  const agentTargetId = options.agentTargetId ?? "local:codex";
  const cassetteId = options.cassetteId ?? `${options.scenario}_ui`;

  return runUiDriveScenario(
    {
      ...options,
      agentTargetId,
      cassetteId
    },
    {
      log,
      prefixes: {
        // Tutti historically omitted a ready line for ui-drive.
        ready: "",
        complete: uiDriveCompletePrefix,
        failed: uiDriveFailedPrefix,
        checkpoint: uiDriveCheckpointPrefix
      },
      emitReady() {},
      captureScreenshot,
      async prepare({ options: runOptions, scenario }) {
        const runtime = await createRuntime(workspaceRoot, "ui-drive");
        const databasePath = join(runtime.stateDirectory, "tuttid.db");
        const scenarioStallTimeoutMs = runOptions.stallTimeoutMs ?? 60_000;
        configureWaitDiagnostics({
          log,
          stallTimeoutMs: scenarioStallTimeoutMs
        });
        const workspaceId = "11111111-1111-4111-8111-111111111111";
        await initializeCleanDatabase(workspaceRoot, runtime, workspaceId);
        await enableAgentSessionRecordingFeature(databasePath, workspaceRoot);
        await enableAgentSessionRecordingTarget(
          databasePath,
          agentTargetId,
          workspaceRoot
        );
        let replayComposerDefaults = null;
        const scenarioState = await scenario.prepare({
          agentTargetId,
          workspaceRoot: projectRoot,
          async selectProject(project) {
            const projectSelection = resolveRecordScenarioProject(
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
          }
        });
        return {
          composerDefaultsMissing: !replayComposerDefaults,
          databasePath,
          runtime,
          scenarioState,
          surface: "agent-gui"
        };
      },
      async launch({ options: runOptions, prepared }) {
        const runtime = prepared.runtime;
        const cdpPort = await reservePort();
        const logPath = join(runtime.directory, "logs", "desktop.log");
        await mkdir(join(runtime.directory, "logs"), { recursive: true });
        const desktopLaunch = preparedDesktopLaunch();
        const desktop = startDesktop({
          args: desktopLaunch?.args,
          cdpPort,
          command: desktopLaunch?.command,
          daemonPath: runtime.daemonPath,
          desktopLogPath: logPath,
          environment: {},
          headless: runOptions.headless === true,
          stateDirectory: runtime.stateDirectory,
          userDataDirectory: runtime.userDataDirectory
        });
        const disposeDesktopShutdown = bindManagedReplayShutdown(desktop);
        const pageWebSocket = await waitForPageWebSocket(
          cdpPort,
          desktop,
          runOptions.timeoutMs
        );
        const pageClient = await CdpClient.connect(pageWebSocket);
        await pageClient.send("Runtime.enable");
        await pageClient.send("Page.enable");
        await prepareAgentGuiSurface(
          pageClient,
          agentTargetId,
          runOptions.timeoutMs
        );
        return {
          desktop,
          disposeDesktopShutdown,
          getClient: () => pageClient,
          pageClient,
          surface: "agent-gui"
        };
      },
      async buildDriveContext({
        options: runOptions,
        prepared,
        launched,
        checkpoint
      }) {
        const pageClient = launched.getClient();
        return {
          checkpoint,
          client: pageClient,
          evaluate: (expression, awaitPromise) =>
            evaluate(pageClient, expression, awaitPromise),
          scenarioState: prepared.scenarioState,
          timeoutMs: runOptions.timeoutMs,
          waitForEvaluation: (expression, label, intervalMs) =>
            waitForEvaluation(
              pageClient,
              expression,
              runOptions.timeoutMs,
              label,
              intervalMs
            )
        };
      },
      async cleanup({ options: runOptions, prepared, launched }) {
        launched?.disposeDesktopShutdown?.();
        if (launched?.pageClient) {
          try {
            launched.pageClient.close?.();
          } catch {
            // ignore
          }
        }
        if (launched?.desktop) {
          await stopProcessTree(launched.desktop).catch(() => {});
        }
        if (prepared?.runtime && !runOptions.keepRuntime) {
          await removeRuntime(prepared.runtime.directory).catch(() => {});
        } else if (prepared?.runtime) {
          log(`runtime kept: ${prepared.runtime.directory}`);
        }
      }
    }
  );
}
