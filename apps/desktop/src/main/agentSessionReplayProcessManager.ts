import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { DesktopLogger } from "./logging.ts";
import {
  resolveDesktopDaemonBaseUrl,
  type DesktopDaemonEndpoint
} from "./transport/paths.ts";

const readyPrefix = "[tutti-agent-session-replay-ready] ";
const completePrefix = "[tutti-agent-session-replay-complete] ";
const failedPrefix = "[tutti-agent-session-replay-failed] ";
const checkpointPrefix = "[tutti-agent-session-replay-checkpoint] ";
const replacePrefix = "[tutti-agent-session-replay-replace] ";
const defaultLaunchTimeoutMs = 180_000;
const maxDiagnosticCharacters = 12_000;

export interface AgentSessionReplayLaunchResult {
  runId: string;
}

export interface AgentSessionReplayProcessManager {
  dispose(): void;
  launch(input: {
    cassetteId: string;
    cassetteDirectory: string;
    runId: string;
    workspaceId: string;
  }): Promise<AgentSessionReplayLaunchResult>;
  waitForCompletion(input: {
    runId: string;
  }): Promise<AgentSessionReplayLaunchResult>;
}

interface CreateAgentSessionReplayProcessManagerInput {
  electronEntry?: string | null;
  electronExecutable: string;
  environment?: NodeJS.ProcessEnv;
  launchTimeoutMs?: number;
  logger: DesktopLogger;
  nodeExecutable: string;
  repositoryRoot: string | null;
  endpoint?: DesktopDaemonEndpoint;
  spawnProcess?: SpawnManagedReplayProcess;
}

interface ManagedReplayLaunch {
  cassetteId: string;
  cassetteDirectory: string;
  runId: string;
  targetCheckpoint?: number;
  workspaceId: string;
}

interface ManagedReplayReplacement {
  cassetteId?: string;
  command: "previous-checkpoint" | "restart" | "switch-cassette";
  currentCheckpoint: number;
}

type ManagedReplayOutcome =
  | { type: "complete" }
  | { replacement: ManagedReplayReplacement; type: "replace" };

interface ManagedReplayChild extends EventEmitter {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  signalCode: NodeJS.Signals | null;
  stderr: Readable;
  stdout: Readable;
}

type SpawnManagedReplayProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
  }
) => ManagedReplayChild;

export function createAgentSessionReplayProcessManager(
  input: CreateAgentSessionReplayProcessManagerInput
): AgentSessionReplayProcessManager {
  const children = new Set<ManagedReplayChild>();
  const completions = new Map<
    string,
    Promise<AgentSessionReplayLaunchResult>
  >();
  const checkpointUpdates = new Map<string, Promise<void>>();
  let cassetteCatalogWrites = Promise.resolve();
  const spawnProcess: SpawnManagedReplayProcess =
    input.spawnProcess ??
    ((command, args, options) =>
      spawn(command, args, options) as ManagedReplayChild);

  return {
    async launch(launchInput) {
      if (!input.repositoryRoot) {
        throw new Error(
          "Agent Session Replay is only available in a development checkout"
        );
      }
      const runId = launchInput.runId.trim();
      if (!runId) {
        throw new Error("Agent Session Replay Run id is required");
      }
      const first = spawnReplay({
        cassetteId: requiredIdentity(launchInput.cassetteId, "Cassette"),
        cassetteDirectory: launchInput.cassetteDirectory,
        runId,
        workspaceId: requiredIdentity(launchInput.workspaceId, "Workspace")
      });
      const completion = supervise(first);
      void completion.catch(() => undefined);
      completions.set(runId, completion);
      try {
        await first.ready;
      } catch (error) {
        completions.delete(runId);
        throw error;
      }
      return { runId };
    },
    async waitForCompletion({ runId }) {
      const completion = completions.get(runId);
      if (!completion) {
        throw new Error(`Agent Session Replay Run is not active: ${runId}`);
      }
      try {
        return await completion;
      } finally {
        completions.delete(runId);
      }
    },
    dispose() {
      for (const child of children) {
        child.kill("SIGTERM");
      }
      children.clear();
      completions.clear();
    }
  };

  function spawnReplay(launch: ManagedReplayLaunch) {
    const repositoryRoot = resolve(input.repositoryRoot!);
    const directory = resolve(launch.cassetteDirectory);
    const environment: NodeJS.ProcessEnv = {
      ...input.environment,
      TUTTI_AGENT_SESSION_REPLAY_ELECTRON_ENTRY:
        input.electronEntry?.trim() ?? "",
      TUTTI_AGENT_SESSION_REPLAY_ELECTRON_EXECUTABLE: input.electronExecutable,
      TUTTI_AGENT_SESSION_REPLAY_PARENT_PID: String(process.pid)
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.TUTTID_ACCESS_TOKEN;
    const args = [
      resolve(repositoryRoot, "tools/scripts/run-agent-session-replay.mjs"),
      "--replay",
      directory,
      "--managed",
      "--run-id",
      launch.runId,
      ...(launch.targetCheckpoint === undefined
        ? []
        : ["--target-checkpoint", String(launch.targetCheckpoint)])
    ];
    const child = spawnProcess(input.nodeExecutable, args, {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.add(child);
    child.once("close", (code, signal) => {
      children.delete(child);
      input.logger.info("managed Agent Session Replay exited", {
        exit_code: code,
        replay_run_id: launch.runId,
        signal
      });
    });
    input.logger.info("managed Agent Session Replay starting", {
      cassette_directory: directory,
      replay_run_id: launch.runId,
      target_checkpoint: launch.targetCheckpoint
    });
    const monitor = monitorManagedReplay(child, {
      expectedRunId: launch.runId,
      logger: input.logger,
      ...(input.endpoint
        ? {
            onCheckpoint: (checkpoint: number) =>
              updateReplayRunCheckpoint(launch, checkpoint),
            onReady: (runtimeDirectory: string) =>
              writeReplayCassetteCatalog(launch, runtimeDirectory)
          }
        : {}),
      timeoutMs: input.launchTimeoutMs ?? defaultLaunchTimeoutMs
    });
    return { ...monitor, launch };
  }

  async function supervise(
    first: ReturnType<typeof spawnReplay>
  ): Promise<AgentSessionReplayLaunchResult> {
    let active = first;
    for (;;) {
      let outcome: ManagedReplayOutcome;
      try {
        outcome = await active.completion;
      } catch (error) {
        if (active !== first) {
          await failReplayRun(active.launch, error).catch(() => undefined);
        }
        void superviseTerminalSurface(active).catch((supervisionError) => {
          input.logger.error("failed replay surface supervision failed", {
            error:
              supervisionError instanceof Error
                ? supervisionError.message
                : String(supervisionError),
            replay_run_id: active.launch.runId
          });
        });
        throw error;
      }
      if (outcome.type === "complete") {
        await checkpointUpdates.get(active.launch.runId);
        void superviseTerminalSurface(active).catch((error) => {
          input.logger.error("terminal replay surface supervision failed", {
            error: error instanceof Error ? error.message : String(error),
            replay_run_id: active.launch.runId
          });
        });
        return { runId: active.launch.runId };
      }
      await checkpointUpdates.get(active.launch.runId);
      await postReplayRunAction(active.launch, "cancel");
      const next = await prepareReplacement(active.launch, outcome.replacement);
      try {
        await postReplayRunAction(next, "running");
        active = spawnReplay(next);
        await active.ready;
      } catch (error) {
        await failReplayRun(next, error).catch(() => undefined);
        throw error;
      }
    }
  }

  async function superviseTerminalSurface(
    terminalSurface: ReturnType<typeof spawnReplay>
  ): Promise<void> {
    let previous = terminalSurface;
    let replacement = await previous.postTerminalReplacement;
    while (replacement) {
      const next = await prepareReplacement(previous.launch, replacement);
      let active: ReturnType<typeof spawnReplay>;
      try {
        await postReplayRunAction(next, "running");
        active = spawnReplay(next);
        await active.ready;
      } catch (error) {
        await failReplayRun(next, error).catch(() => undefined);
        throw error;
      }
      let outcome: ManagedReplayOutcome;
      try {
        outcome = await active.completion;
      } catch (error) {
        await failReplayRun(active.launch, error).catch(() => undefined);
        previous = active;
        replacement = await active.postTerminalReplacement;
        continue;
      }
      await checkpointUpdates.get(active.launch.runId);
      if (outcome.type === "replace") {
        await postReplayRunAction(active.launch, "cancel");
        previous = active;
        replacement = outcome.replacement;
        continue;
      }
      await postReplayRunAction(active.launch, "complete");
      previous = active;
      replacement = await active.postTerminalReplacement;
    }
  }

  async function prepareReplacement(
    previous: ManagedReplayLaunch,
    replacement: ManagedReplayReplacement
  ): Promise<ManagedReplayLaunch> {
    const cassetteId =
      replacement.command === "switch-cassette"
        ? requiredIdentity(replacement.cassetteId, "Replacement Cassette")
        : previous.cassetteId;
    const prepared = await prepareReplayRun(previous.workspaceId, cassetteId);
    return {
      cassetteId,
      cassetteDirectory: prepared.cassetteDirectory,
      runId: prepared.run.id,
      workspaceId: previous.workspaceId,
      ...(replacement.command === "previous-checkpoint"
        ? {
            targetCheckpoint: Math.max(replacement.currentCheckpoint - 1, 0)
          }
        : {})
    };
  }

  async function prepareReplayRun(workspaceId: string, cassetteId: string) {
    return requestPrimaryDaemon<{
      cassetteDirectory: string;
      run: { id: string };
    }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-session-cassettes/${encodeURIComponent(cassetteId)}/replay-runs`,
      { method: "POST" }
    );
  }

  async function postReplayRunAction(
    launch: ManagedReplayLaunch,
    action: "cancel" | "complete" | "running"
  ) {
    await requestPrimaryDaemon(
      `/v1/workspaces/${encodeURIComponent(launch.workspaceId)}/agent-session-replay-runs/${encodeURIComponent(launch.runId)}/${action}`,
      { method: "POST" }
    );
  }

  async function updateReplayRunCheckpoint(
    launch: ManagedReplayLaunch,
    checkpoint: number
  ) {
    const previous = checkpointUpdates.get(launch.runId) ?? Promise.resolve();
    const update = previous.then(() =>
      requestPrimaryDaemon(
        `/v1/workspaces/${encodeURIComponent(launch.workspaceId)}/agent-session-replay-runs/${encodeURIComponent(launch.runId)}/checkpoint`,
        {
          body: JSON.stringify({ checkpoint }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }
      ).then(() => undefined)
    );
    checkpointUpdates.set(launch.runId, update);
    await update;
  }

  async function failReplayRun(launch: ManagedReplayLaunch, error: unknown) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : String(error);
    await requestPrimaryDaemon(
      `/v1/workspaces/${encodeURIComponent(launch.workspaceId)}/agent-session-replay-runs/${encodeURIComponent(launch.runId)}/fail`,
      {
        body: JSON.stringify({
          errorCode: "replay_runtime_failed",
          errorMessage: message
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    );
  }

  function writeReplayCassetteCatalog(
    launch: ManagedReplayLaunch,
    runtimeDirectory: string
  ): Promise<void> {
    const write = cassetteCatalogWrites.then(async () => {
      const catalog = await requestPrimaryDaemon<{
        cassettes: Array<{ id: string; name: string }>;
      }>(
        `/v1/workspaces/${encodeURIComponent(launch.workspaceId)}/agent-session-cassettes`
      );
      const path = join(resolve(runtimeDirectory), "replay-catalog.json");
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({
          cassetteId: launch.cassetteId,
          cassettes: catalog.cassettes.map(({ id, name }) => ({ id, name }))
        })
      );
      await rename(temporaryPath, path);
    });
    cassetteCatalogWrites = write.catch(() => undefined);
    return write;
  }

  async function requestPrimaryDaemon<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    if (!input.endpoint) {
      throw new Error("Primary daemon access is unavailable");
    }
    // eslint-disable-next-line no-restricted-globals -- This authenticated request targets the managed primary loopback daemon.
    const response = await fetch(
      `${resolveDesktopDaemonBaseUrl(input.endpoint)}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${input.endpoint.accessToken}`,
          ...init?.headers
        }
      }
    );
    if (!response.ok) {
      throw new Error(
        `Agent Session Replay supervisor request failed with ${response.status}: ${await response.text()}`
      );
    }
    return (await response.json()) as T;
  }
}

function requiredIdentity(value: string | undefined, label: string): string {
  const identity = value?.trim() ?? "";
  if (!identity) throw new Error(`${label} id is required`);
  return identity;
}

function monitorManagedReplay(
  child: ManagedReplayChild,
  input: {
    expectedRunId: string;
    logger: DesktopLogger;
    timeoutMs: number;
    onCheckpoint?: (checkpoint: number) => Promise<void>;
    onReady?: (runtimeDirectory: string) => Promise<void>;
  }
): {
  completion: Promise<ManagedReplayOutcome>;
  postTerminalReplacement: Promise<ManagedReplayReplacement | null>;
  ready: Promise<void>;
} {
  let complete = false;
  let pendingReplacement: ManagedReplayReplacement | null = null;
  let terminal = false;
  let ready = false;
  let stdoutBuffer = "";
  let diagnostics = "";
  let resolveComplete!: (outcome: ManagedReplayOutcome) => void;
  let rejectComplete!: (error: Error) => void;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolvePostTerminalReplacement!: (
    replacement: ManagedReplayReplacement | null
  ) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completionPromise = new Promise<ManagedReplayOutcome>(
    (resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    }
  );
  void completionPromise.catch(() => undefined);
  const postTerminalReplacementPromise =
    new Promise<ManagedReplayReplacement | null>((resolve) => {
      resolvePostTerminalReplacement = resolve;
    });

  const cleanup = () => {
    clearTimeout(readyTimeout);
    clearTimeout(completionTimeout);
    child.off("error", onError);
    child.off("exit", onExit);
    child.stdout.off("data", onStdout);
    child.stderr.off("data", onStderr);
  };
  const fail = (error: Error) => {
    if (terminal) {
      cleanup();
      resolvePostTerminalReplacement(null);
      return;
    }
    if (complete) return;
    cleanup();
    child.kill("SIGTERM");
    if (!ready) {
      rejectReady(error);
    }
    rejectComplete(error);
  };
  const appendDiagnostic = (chunk: unknown) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(
      -maxDiagnosticCharacters
    );
  };
  const onError = (error: Error) => fail(error);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (pendingReplacement) {
      cleanup();
      if (terminal) {
        resolvePostTerminalReplacement(pendingReplacement);
      } else {
        complete = true;
        resolveComplete({
          replacement: pendingReplacement,
          type: "replace"
        });
      }
      return;
    }
    if (terminal) {
      cleanup();
      resolvePostTerminalReplacement(null);
      return;
    }
    fail(
      new Error(
        `Replay Electron failed ${ready ? "before completion" : "before it became ready"} (${code ?? signal ?? "unknown"}): ${diagnostics.trim()}`
      )
    );
  };
  const onStderr = (chunk: unknown) => {
    appendDiagnostic(chunk);
    input.logger.debug("managed Agent Session Replay output", {
      output: String(chunk).trim()
    });
  };
  const parseEvent = (
    line: string,
    prefix: string,
    event: string
  ): Record<string, unknown> | null => {
    try {
      const payload = JSON.parse(line.slice(prefix.length)) as Record<
        string,
        unknown
      >;
      if (payload.runId !== input.expectedRunId) {
        fail(new Error("Replay Electron reported a mismatched Run id"));
        return null;
      }
      return payload;
    } catch (error) {
      fail(
        new Error(
          `Replay Electron reported an invalid ${event} event: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return null;
    }
  };
  const onStdout = (chunk: unknown) => {
    appendDiagnostic(chunk);
    stdoutBuffer += String(chunk);
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.startsWith(readyPrefix)) {
        const payload = parseEvent(line, readyPrefix, "ready");
        if (!ready && payload) {
          const runtimeDirectory =
            typeof payload.runtimeDirectory === "string"
              ? payload.runtimeDirectory
              : "";
          if (input.onReady && !runtimeDirectory) {
            fail(new Error("Replay Electron omitted its runtime directory"));
            return;
          }
          clearTimeout(readyTimeout);
          ready = true;
          resolveReady();
          void input.onReady?.(runtimeDirectory).catch(fail);
        }
        continue;
      }
      if (line.startsWith(checkpointPrefix)) {
        const payload = parseEvent(line, checkpointPrefix, "checkpoint");
        if (!payload) return;
        const checkpoint = payload.checkpoint;
        if (!Number.isSafeInteger(checkpoint) || (checkpoint as number) < 0) {
          fail(new Error("Replay Electron reported an invalid checkpoint"));
          return;
        }
        void input.onCheckpoint?.(checkpoint as number).catch(fail);
        continue;
      }
      if (line.startsWith(replacePrefix)) {
        const payload = parseEvent(line, replacePrefix, "replace");
        if (!payload) return;
        const command = payload.command;
        const currentCheckpoint = payload.currentCheckpoint;
        if (
          !["previous-checkpoint", "restart", "switch-cassette"].includes(
            String(command)
          ) ||
          !Number.isSafeInteger(currentCheckpoint) ||
          (currentCheckpoint as number) < 0
        ) {
          fail(new Error("Replay Electron reported an invalid replacement"));
          return;
        }
        const replacement: ManagedReplayReplacement = {
          ...(typeof payload.cassetteId === "string"
            ? { cassetteId: payload.cassetteId }
            : {}),
          command: command as ManagedReplayReplacement["command"],
          currentCheckpoint: currentCheckpoint as number
        };
        pendingReplacement = replacement;
        continue;
      }
      if (line.startsWith(completePrefix)) {
        if (!ready) {
          fail(
            new Error(
              "Replay Electron reported completion before it became ready"
            )
          );
          return;
        }
        if (!parseEvent(line, completePrefix, "complete")) {
          return;
        }
        if (!complete) {
          complete = true;
          terminal = true;
          clearTimeout(completionTimeout);
          resolveComplete({ type: "complete" });
        }
        continue;
      }
      if (line.startsWith(failedPrefix)) {
        const payload = parseEvent(line, failedPrefix, "failed");
        if (!payload) {
          return;
        }
        const error = new Error(
          (typeof payload.error === "string" && payload.error.trim()) ||
            "Agent Session Replay failed"
        );
        if (!ready) {
          fail(error);
          return;
        }
        if (!complete) {
          complete = true;
          terminal = true;
          clearTimeout(completionTimeout);
          rejectComplete(error);
        }
      }
    }
  };
  const readyTimeout = setTimeout(
    () =>
      fail(
        new Error(
          `Replay Electron did not become ready within ${input.timeoutMs} ms: ${diagnostics.trim()}`
        )
      ),
    input.timeoutMs
  );
  const completionTimeout = setTimeout(
    () =>
      fail(
        new Error(
          `Replay Electron did not complete within ${input.timeoutMs} ms: ${diagnostics.trim()}`
        )
      ),
    input.timeoutMs * 2
  );
  child.once("error", onError);
  child.once("exit", onExit);
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  return {
    completion: completionPromise,
    postTerminalReplacement: postTerminalReplacementPromise,
    ready: readyPromise
  };
}
