import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
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
import { bindManagedReplayShutdown } from "./desktop-shutdown.mjs";
import {
  createRuntime,
  enableAgentSessionRecordingFeature,
  enableAgentSessionRecordingTarget,
  initializeCleanDatabase,
  preparedDesktopLaunch,
  removeRuntime,
  setAgentComposerDefaults
} from "./runtime.mjs";

export const uiDriveCompletePrefix = "[tutti-agent-session-replay-complete] ";
export const uiDriveFailedPrefix = "[tutti-agent-session-replay-failed] ";
export const uiDriveCheckpointPrefix =
  "[tutti-agent-session-replay-checkpoint] ";

function log(message) {
  process.stderr.write(`[agent-session-replay] ${message}\n`);
}

export async function loadUiScenario(options) {
  const module = await import(pathToFileURL(options.scenarioFile).href);
  const scenario = module.default;
  if (
    !scenario ||
    scenario.id !== options.scenario ||
    scenario.kind !== "ui" ||
    typeof scenario.prepare !== "function" ||
    typeof scenario.drive !== "function" ||
    typeof scenario.assert !== "function"
  ) {
    throw new Error(
      `ui scenario file does not export ui scenario ${options.scenario}: ${options.scenarioFile}`
    );
  }
  return scenario;
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
  const projectRoot = resolveAgentSessionReplayProjectRoot(workspaceRoot);
  const artifactDirectory = options.artifactDirectory;
  const agentTargetId = options.agentTargetId ?? "local:codex";
  const cassetteId = options.cassetteId ?? `${options.scenario}_ui`;
  await mkdir(artifactDirectory, { recursive: true });
  const runtime = await createRuntime(workspaceRoot, "ui-drive");
  const databasePath = join(runtime.stateDirectory, "tuttid.db");
  let pageClient = null;
  let desktop = null;
  let disposeDesktopShutdown = () => {};
  const checkpoints = [];
  try {
    const scenarioStallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    // Scenario modules live in the replay-cases checkout and import their own
    // wait helper. Pass the runner's stall policy across that module boundary.
    process.env.TUTTI_AGENT_SESSION_REPLAY_STALL_TIMEOUT_MS = String(
      scenarioStallTimeoutMs
    );
    configureWaitDiagnostics({
      log,
      stallTimeoutMs: scenarioStallTimeoutMs
    });
    const scenario = await loadUiScenario(options);
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    await initializeCleanDatabase(workspaceRoot, runtime, workspaceId);
    await enableAgentSessionRecordingFeature(databasePath, workspaceRoot);
    await enableAgentSessionRecordingTarget(
      databasePath,
      agentTargetId,
      workspaceRoot
    );
    let replayComposerDefaults = null;
    let projectSelection = null;
    const scenarioState = await scenario.prepare({
      agentTargetId,
      // Scenarios treat workspaceRoot as the bound Agent project tree.
      workspaceRoot: projectRoot,
      async selectProject(project) {
        // Pure-UI project-picker scenarios may seed multiple known projects.
        projectSelection = resolveRecordScenarioProject(project, projectRoot);
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
    if (!replayComposerDefaults && scenario.requireComposerDefaults !== false) {
      throw new Error(
        `ui scenario ${scenario.id} did not set composer defaults`
      );
    }

    const cdpPort = await reservePort();
    const logPath = join(runtime.directory, "logs", "desktop.log");
    await mkdir(join(runtime.directory, "logs"), { recursive: true });
    const desktopLaunch = preparedDesktopLaunch();
    desktop = startDesktop({
      args: desktopLaunch?.args,
      cdpPort,
      command: desktopLaunch?.command,
      daemonPath: runtime.daemonPath,
      desktopLogPath: logPath,
      environment: {},
      headless: options.headless === true,
      stateDirectory: runtime.stateDirectory,
      userDataDirectory: runtime.userDataDirectory
    });
    // Desktop is detached; without this, SIGTERM/parent death leaves Dock icons.
    disposeDesktopShutdown = bindManagedReplayShutdown(desktop);
    const pageWebSocket = await waitForPageWebSocket(
      cdpPort,
      desktop,
      options.timeoutMs
    );
    pageClient = await CdpClient.connect(pageWebSocket);
    await pageClient.send("Runtime.enable");
    await pageClient.send("Page.enable");
    await prepareAgentGuiSurface(pageClient, agentTargetId, options.timeoutMs);

    const totalCheckpoints =
      typeof scenario.plannedCheckpoints === "number" &&
      scenario.plannedCheckpoints > 0
        ? scenario.plannedCheckpoints
        : null;

    async function checkpoint(name, assertFn) {
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
        throw new Error(`invalid ui checkpoint name: ${name}`);
      }
      if (typeof assertFn === "function") {
        await assertFn({
          client: pageClient,
          evaluate: (expression, awaitPromise) =>
            evaluate(pageClient, expression, awaitPromise),
          scenarioState,
          timeoutMs: options.timeoutMs,
          waitForEvaluation: (expression, label, intervalMs) =>
            waitForEvaluation(
              pageClient,
              expression,
              options.timeoutMs,
              label,
              intervalMs
            )
        });
      }
      const index = checkpoints.length;
      const id = `checkpoint-${String(index + 1).padStart(4, "0")}`;
      const outputPath = join(artifactDirectory, cassetteId, `${id}.png`);
      await mkdir(join(artifactDirectory, cassetteId), { recursive: true });
      await captureScreenshot(pageClient, outputPath);
      checkpoints.push({ id, name, path: outputPath });
      const progress = {
        cassetteId,
        checkpoint: index + 1,
        totalCheckpoints: totalCheckpoints ?? index + 1,
        name
      };
      process.stderr.write(
        `${uiDriveCheckpointPrefix}${JSON.stringify(progress)}\n`
      );
      log(`checkpoint screenshot: ${outputPath}`);
      return { index, path: outputPath };
    }

    await scenario.drive({
      checkpoint,
      client: pageClient,
      evaluate: (expression, awaitPromise) =>
        evaluate(pageClient, expression, awaitPromise),
      scenarioState,
      timeoutMs: options.timeoutMs,
      waitForEvaluation: (expression, label, intervalMs) =>
        waitForEvaluation(
          pageClient,
          expression,
          options.timeoutMs,
          label,
          intervalMs
        )
    });

    await scenario.assert({
      checkpoint,
      client: pageClient,
      phase: "terminal",
      scenarioState,
      timeoutMs: options.timeoutMs
    });

    const planPath = join(
      artifactDirectory,
      cassetteId,
      "ui-checkpoint-plan.json"
    );
    await writeFile(
      planPath,
      `${JSON.stringify(
        {
          cassetteId,
          checkpoints: checkpoints.map((item, index) => ({
            id: item.id,
            index: index + 1,
            name: item.name,
            screenshot: item.path
          })),
          kind: "ui-drive",
          scenarioId: scenario.id
        },
        null,
        2
      )}\n`
    );

    process.stderr.write(
      `${uiDriveCompletePrefix}${JSON.stringify({ cassetteId })}\n`
    );
    log(`ui-drive complete: ${cassetteId} checkpoints=${checkpoints.length}`);
    return { artifactDirectory, cassetteId, checkpoints, runtime };
  } catch (error) {
    process.stderr.write(
      `${uiDriveFailedPrefix}${JSON.stringify({
        cassetteId,
        error: error instanceof Error ? error.message : String(error)
      })}\n`
    );
    throw error;
  } finally {
    disposeDesktopShutdown();
    if (pageClient) {
      try {
        pageClient.close?.();
      } catch {
        // ignore
      }
    }
    if (desktop) {
      await stopProcessTree(desktop).catch(() => {});
    }
    if (!options.keepRuntime) {
      await removeRuntime(runtime.directory).catch(() => {});
    } else {
      log(`runtime kept: ${runtime.directory}`);
    }
  }
}
