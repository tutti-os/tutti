import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  managedReplayCheckpointPrefix,
  managedReplayCompletePrefix,
  managedReplayFailedPrefix,
  managedReplayReadyPrefix
} from "./managed-log-prefixes.mjs";

/**
 * @typedef {object} UiDriveScenarioModule
 * @property {string} id
 * @property {"ui"} kind
 * @property {(input: object) => unknown | Promise<unknown>} prepare
 * @property {(input: object) => unknown | Promise<unknown>} drive
 * @property {(input: object) => unknown | Promise<unknown>} assert
 * @property {number} [plannedCheckpoints]
 * @property {boolean} [requireComposerDefaults]
 */

/**
 * @typedef {object} UiDriveRunPorts
 * Product adapters for pure-UI scenarios. Shared code owns scenario load,
 * stall env, checkpoint naming/screenshots/plan JSON, and complete/fail logs.
 *
 * @property {(input: {
 *   options: object,
 *   scenario: UiDriveScenarioModule,
 *   log: (message: string) => void
 * }) => Promise<{
 *   scenarioState?: unknown,
 *   runtime?: unknown,
 *   surface?: string,
 *   [key: string]: unknown
 * }>} prepare
 * @property {(input: {
 *   options: object,
 *   scenario: UiDriveScenarioModule,
 *   prepared: object,
 *   log: (message: string) => void
 * }) => Promise<{
 *   getClient: () => object,
 *   surface?: string,
 *   [key: string]: unknown
 * }>} launch
 * @property {(input: {
 *   options: object,
 *   scenario: UiDriveScenarioModule,
 *   prepared: object,
 *   launched: object,
 *   checkpoint: (name: string, assertFn?: Function) => Promise<object>,
 *   log: (message: string) => void
 * }) => object | Promise<object>} buildDriveContext
 * @property {(client: object, outputPath: string) => Promise<void>} captureScreenshot
 * @property {(input: {
 *   options: object,
 *   prepared: object,
 *   launched: object | null,
 *   error: unknown | null,
 *   log: (message: string) => void
 * }) => unknown | Promise<unknown>} [cleanup]
 * @property {(message: string) => void} [log]
 * @property {{
 *   ready?: string,
 *   complete?: string,
 *   failed?: string,
 *   checkpoint?: string
 * }} [prefixes]
 * @property {(payload: object) => void} [emitReady]
 */

/**
 * Load and validate a pure-UI scenario module (kind === "ui").
 * @param {{ scenario: string, scenarioFile: string }} options
 * @returns {Promise<UiDriveScenarioModule>}
 */
export async function loadUiScenario(options) {
  const scenarioFile = String(options?.scenarioFile ?? "").trim();
  const scenarioID = String(options?.scenario ?? "").trim();
  if (!scenarioFile) throw new Error("scenarioFile is required");
  if (!scenarioID) throw new Error("ui-drive scenario is required");
  const module = await import(pathToFileURL(scenarioFile).href);
  const scenario = module.default;
  if (
    !scenario ||
    scenario.id !== scenarioID ||
    scenario.kind !== "ui" ||
    typeof scenario.prepare !== "function" ||
    typeof scenario.drive !== "function" ||
    typeof scenario.assert !== "function"
  ) {
    throw new Error(
      `ui scenario file does not export ui scenario ${scenarioID}: ${scenarioFile}`
    );
  }
  return scenario;
}

/**
 * @param {string} name
 */
export function assertValidUiCheckpointName(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(String(name ?? ""))) {
    throw new Error(`invalid ui checkpoint name: ${name}`);
  }
}

/**
 * @param {object} input
 * @param {string} input.artifactDirectory
 * @param {string} input.cassetteId
 * @param {object} input.client
 * @param {(client: object, outputPath: string) => Promise<void>} input.captureScreenshot
 * @param {string} input.name
 * @param {Array<{ id: string, name: string, path: string }>} input.checkpoints
 * @returns {Promise<{ id: string, index: number, name: string, path: string }>}
 */
export async function recordUiCheckpointScreenshot(input) {
  assertValidUiCheckpointName(input.name);
  const index = input.checkpoints.length;
  const id = `checkpoint-${String(index + 1).padStart(4, "0")}`;
  const cassetteArtifactDirectory = join(
    input.artifactDirectory,
    input.cassetteId
  );
  const outputPath = join(cassetteArtifactDirectory, `${id}.png`);
  await mkdir(cassetteArtifactDirectory, { recursive: true });
  await input.captureScreenshot(input.client, outputPath);
  const entry = { id, name: input.name, path: outputPath };
  input.checkpoints.push(entry);
  return { ...entry, index };
}

/**
 * Run a pure-UI scenario with step checkpoints. Does not create Session Replay
 * cassettes. Product hosts inject prepare/launch/surface via ports.
 *
 * @param {object} options
 * @param {UiDriveRunPorts} ports
 */
export async function runUiDriveScenario(options, ports) {
  if (!ports || typeof ports !== "object") {
    throw new Error("runUiDriveScenario requires ports");
  }
  if (typeof ports.prepare !== "function") {
    throw new Error("runUiDriveScenario ports.prepare is required");
  }
  if (typeof ports.launch !== "function") {
    throw new Error("runUiDriveScenario ports.launch is required");
  }
  if (typeof ports.buildDriveContext !== "function") {
    throw new Error("runUiDriveScenario ports.buildDriveContext is required");
  }
  if (typeof ports.captureScreenshot !== "function") {
    throw new Error("runUiDriveScenario ports.captureScreenshot is required");
  }

  const artifactDirectory = String(options?.artifactDirectory ?? "").trim();
  if (!artifactDirectory) throw new Error("artifactDirectory is required");
  const cassetteId = String(
    options?.cassetteId ?? `${options?.scenario ?? "scenario"}_ui`
  ).trim();
  if (!cassetteId) throw new Error("cassetteId is required");

  const log =
    typeof ports.log === "function"
      ? ports.log
      : (message) => {
          process.stderr.write(`[agent-session-replay] ${message}\n`);
        };
  const prefixes = {
    ready: ports.prefixes?.ready ?? managedReplayReadyPrefix,
    complete: ports.prefixes?.complete ?? managedReplayCompletePrefix,
    failed: ports.prefixes?.failed ?? managedReplayFailedPrefix,
    checkpoint: ports.prefixes?.checkpoint ?? managedReplayCheckpointPrefix
  };

  await mkdir(artifactDirectory, { recursive: true });

  const previousStall = process.env.TUTTI_AGENT_SESSION_REPLAY_STALL_TIMEOUT_MS;
  const stallTimeoutMs =
    options.stallTimeoutMs === undefined
      ? 60_000
      : Number(options.stallTimeoutMs);

  let prepared = null;
  let launched = null;
  const checkpoints = [];
  let scenario = null;
  let runError = null;

  try {
    process.env.TUTTI_AGENT_SESSION_REPLAY_STALL_TIMEOUT_MS = String(
      Number.isFinite(stallTimeoutMs) ? stallTimeoutMs : 60_000
    );

    scenario = await loadUiScenario(options);
    prepared = await ports.prepare({ options, scenario, log });
    if (!prepared || typeof prepared !== "object") {
      throw new Error("ui-drive ports.prepare must return an object");
    }

    if (
      scenario.requireComposerDefaults !== false &&
      prepared.composerDefaultsMissing === true
    ) {
      throw new Error(
        `ui scenario ${scenario.id} did not set composer defaults`
      );
    }

    launched = await ports.launch({ options, scenario, prepared, log });
    if (!launched || typeof launched.getClient !== "function") {
      throw new Error(
        "ui-drive ports.launch must return { getClient: () => client }"
      );
    }

    const surface = String(
      launched.surface ?? prepared.surface ?? "agent-gui"
    ).trim();

    if (typeof ports.emitReady === "function") {
      ports.emitReady({
        cassetteId,
        mode: "ui-drive",
        surface,
        prepared,
        launched
      });
    } else if (prefixes.ready) {
      process.stdout.write(
        `${prefixes.ready}${JSON.stringify({
          cassetteId,
          mode: "ui-drive",
          surface,
          ...(prepared.runtimeDirectory
            ? { runtimeDirectory: prepared.runtimeDirectory }
            : {}),
          ...(prepared.workspaceId != null
            ? { workspaceId: prepared.workspaceId }
            : {})
        })}\n`
      );
    }

    const totalCheckpoints =
      typeof scenario.plannedCheckpoints === "number" &&
      scenario.plannedCheckpoints > 0
        ? scenario.plannedCheckpoints
        : null;

    async function checkpoint(name, assertFn) {
      assertValidUiCheckpointName(name);
      const driveContext = await ports.buildDriveContext({
        options,
        scenario,
        prepared,
        launched,
        checkpoint,
        log
      });
      if (typeof assertFn === "function") {
        await assertFn(driveContext);
      }
      const recorded = await recordUiCheckpointScreenshot({
        artifactDirectory,
        cassetteId,
        client: launched.getClient(),
        captureScreenshot: ports.captureScreenshot,
        name,
        checkpoints
      });
      process.stderr.write(
        `${prefixes.checkpoint}${JSON.stringify({
          cassetteId,
          checkpoint: recorded.index + 1,
          totalCheckpoints: totalCheckpoints ?? recorded.index + 1,
          name
        })}\n`
      );
      log(`checkpoint screenshot: ${recorded.path}`);
      return { index: recorded.index, path: recorded.path };
    }

    const driveContext = await ports.buildDriveContext({
      options,
      scenario,
      prepared,
      launched,
      checkpoint,
      log
    });
    await scenario.drive(driveContext);
    await scenario.assert({
      ...driveContext,
      phase: "terminal"
    });

    const cassetteArtifactDirectory = join(artifactDirectory, cassetteId);
    await mkdir(cassetteArtifactDirectory, { recursive: true });
    const planPath = join(cassetteArtifactDirectory, "ui-checkpoint-plan.json");
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
      `${prefixes.complete}${JSON.stringify({
        cassetteId,
        checkpoints: checkpoints.length
      })}\n`
    );
    log(`ui-drive complete: ${cassetteId} checkpoints=${checkpoints.length}`);

    return {
      artifactDirectory,
      cassetteId,
      checkpoints,
      prepared,
      launched,
      runtime: prepared.runtime,
      scenarioState: prepared.scenarioState,
      workspaceId: prepared.workspaceId ?? null
    };
  } catch (error) {
    runError = error;
    process.stderr.write(
      `${prefixes.failed}${JSON.stringify({
        cassetteId,
        error: error instanceof Error ? error.message : String(error)
      })}\n`
    );
    throw error;
  } finally {
    if (previousStall === undefined) {
      delete process.env.TUTTI_AGENT_SESSION_REPLAY_STALL_TIMEOUT_MS;
    } else {
      process.env.TUTTI_AGENT_SESSION_REPLAY_STALL_TIMEOUT_MS = previousStall;
    }
    if (typeof ports.cleanup === "function") {
      await Promise.resolve(
        ports.cleanup({
          options,
          prepared,
          launched,
          error: runError,
          log
        })
      ).catch((cleanupError) => {
        log(
          `failed to cleanup ui-drive: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`
        );
      });
    }
  }
}
