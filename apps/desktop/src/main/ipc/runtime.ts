import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopIpcChannels,
  type DesktopTerminalStreamUrlRequest,
  type DesktopAgentSessionReplayPlayback,
  type DesktopAgentSessionReplayTimingMode,
  type DesktopBackendConfig,
  type DesktopRendererDiagnosticPayload,
  type DesktopRuntimeLogLevel,
  type DesktopSetAgentSessionReplayPlaybackInput,
  type DesktopTerminalDiagnosticPayload
} from "../../shared/contracts/ipc";
import type { DesktopLogger } from "../logging";
import {
  resolveDesktopDaemonBaseUrl,
  resolveDesktopBusinessEventStreamUrl,
  resolveDesktopTerminalStreamUrl,
  type DesktopDaemonEndpoint
} from "../transport/paths";
import { listDesktopWorkspaceAgentProbes } from "../agentProviderUsageProbe";
import { createAgentSessionReplayProcessManager } from "../agentSessionReplayProcessManager.ts";
import {
  createAgentSessionReplayControlWriter,
  readAgentSessionReplayStatus
} from "../agentSessionReplayStatus.ts";
import { registerDesktopIpcHandler } from "./handle";

export function registerRuntimeIpc(
  endpoint: DesktopDaemonEndpoint,
  logger: DesktopLogger
): { dispose(): void } {
  const replayProcessManager = createAgentSessionReplayProcessManager({
    electronEntry: app.isPackaged ? null : app.getAppPath(),
    electronExecutable: process.execPath,
    endpoint,
    environment: process.env,
    logger,
    nodeExecutable: process.env.npm_node_execpath?.trim() || "node",
    repositoryRoot: resolveAgentSessionReplayRoot()
  });
  const sendReplayControl = createAgentSessionReplayControlWriter();
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.launchAgentSessionReplay,
    (_event, input) => replayProcessManager.launch(input)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.getAgentSessionReplayPlayback,
    () => getAgentSessionReplayPlayback(endpoint)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.getAgentSessionReplayStatus,
    () => readAgentSessionReplayStatus()
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.setAgentSessionReplayPlayback,
    (_event, input) => setAgentSessionReplayPlayback(endpoint, input)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.sendAgentSessionReplayControl,
    (_event, input) => sendReplayControl(input)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.waitForAgentSessionReplay,
    (_event, input) => replayProcessManager.waitForCompletion(input)
  );
  registerDesktopIpcHandler(desktopIpcChannels.runtime.getBackendConfig, () =>
    resolveBackendConfig(endpoint)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.getBusinessEventStreamUrl,
    () => resolveBusinessEventStreamUrl(endpoint)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.listWorkspaceAgentProbes,
    (_event, input) => listDesktopWorkspaceAgentProbes(input)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.getTerminalStreamUrl,
    (_event, input) => resolveTerminalStreamUrl(endpoint, input)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.logTerminalDiagnostic,
    (_event, input) => {
      logTerminalDiagnostic(logger, input);
    }
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.logRendererDiagnostic,
    (_event, input) => {
      logRendererDiagnostic(logger, input);
    }
  );
  return replayProcessManager;
}

async function getAgentSessionReplayPlayback(
  endpoint: DesktopDaemonEndpoint
): Promise<DesktopAgentSessionReplayPlayback> {
  // eslint-disable-next-line no-restricted-globals -- This authenticated request targets the managed loopback daemon.
  const response = await fetch(
    `${resolveDesktopDaemonBaseUrl(endpoint)}/v1/agent-session-replay/transport/playback`,
    {
      headers: { authorization: `Bearer ${endpoint.accessToken}` }
    }
  );
  if (response.status === 503) {
    return {
      active: false,
      paused: false,
      speed: 1,
      timingMode: "realtime"
    };
  }
  if (!response.ok) {
    throw new Error(`Replay playback read failed with ${response.status}`);
  }
  return resolveAgentSessionReplayPlayback(await response.json());
}

async function setAgentSessionReplayPlayback(
  endpoint: DesktopDaemonEndpoint,
  input: DesktopSetAgentSessionReplayPlaybackInput
): Promise<DesktopAgentSessionReplayPlayback> {
  const command = resolveAgentSessionReplayPlaybackCommand(input);
  // eslint-disable-next-line no-restricted-globals -- This authenticated request targets the managed loopback daemon.
  const response = await fetch(
    `${resolveDesktopDaemonBaseUrl(endpoint)}/v1/agent-session-replay/transport/playback`,
    {
      body: JSON.stringify(command),
      headers: {
        authorization: `Bearer ${endpoint.accessToken}`,
        "content-type": "application/json"
      },
      method: "POST"
    }
  );
  if (!response.ok) {
    throw new Error(`Replay playback update failed with ${response.status}`);
  }
  return resolveAgentSessionReplayPlayback(await response.json());
}

function resolveAgentSessionReplayPlayback(
  value: unknown
): DesktopAgentSessionReplayPlayback {
  const playback = value as {
    paused?: unknown;
    speed?: unknown;
    timingMode?: unknown;
  };
  return {
    active: true,
    paused: resolveAgentSessionReplayPaused(playback.paused),
    speed: resolveAgentSessionReplayPlaybackSpeed(playback.speed),
    timingMode: resolveAgentSessionReplayTimingMode(playback.timingMode)
  };
}

function resolveAgentSessionReplayPlaybackSpeed(
  value: unknown
): DesktopAgentSessionReplayPlayback["speed"] {
  switch (value) {
    case 0.25:
    case 0.5:
    case 1:
    case 2:
    case 4:
      return value;
    default:
      throw new Error(`Unsupported replay playback speed: ${value}`);
  }
}

function resolveAgentSessionReplayPaused(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Unsupported replay paused state: ${String(value)}`);
  }
  return value;
}

function resolveAgentSessionReplayTimingMode(
  value: unknown
): DesktopAgentSessionReplayTimingMode {
  if (value === "realtime" || value === "fast-forward") {
    return value;
  }
  throw new Error(`Unsupported replay timing mode: ${String(value)}`);
}

function resolveAgentSessionReplayPlaybackCommand(
  input: DesktopSetAgentSessionReplayPlaybackInput
): DesktopSetAgentSessionReplayPlaybackInput {
  switch (input.command) {
    case "pause":
    case "resume":
      return { command: input.command };
    case "set-speed":
      return {
        command: input.command,
        speed: resolveAgentSessionReplayPlaybackSpeed(input.speed)
      };
    case "set-timing-mode":
      return {
        command: input.command,
        timingMode: resolveAgentSessionReplayTimingMode(input.timingMode)
      };
  }
}

export function resolveAgentSessionReplayRoot(
  currentDirectory = dirname(fileURLToPath(import.meta.url)),
  isPackaged = app.isPackaged
): string | null {
  if (isPackaged) {
    return null;
  }
  let candidate = resolve(currentDirectory);
  for (;;) {
    if (
      existsSync(join(candidate, "pnpm-workspace.yaml")) &&
      existsSync(
        join(candidate, "tools", "scripts", "run-agent-session-replay.mjs")
      )
    ) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

function resolveBackendConfig(
  endpoint: DesktopDaemonEndpoint
): DesktopBackendConfig {
  return {
    accessToken: endpoint.accessToken,
    baseUrl: resolveDesktopDaemonBaseUrl(endpoint)
  };
}

function resolveTerminalStreamUrl(
  endpoint: DesktopDaemonEndpoint,
  input: DesktopTerminalStreamUrlRequest
): string {
  return resolveDesktopTerminalStreamUrl(endpoint, input);
}

function resolveBusinessEventStreamUrl(
  endpoint: DesktopDaemonEndpoint
): string {
  return resolveDesktopBusinessEventStreamUrl(endpoint);
}

function logTerminalDiagnostic(
  logger: DesktopLogger,
  input: DesktopTerminalDiagnosticPayload
): void {
  const log = resolveLogMethod(logger, input.level ?? "info");
  log("terminal diagnostic", {
    details: input.details ?? {},
    terminal_event: input.event,
    terminal_node_id: input.nodeId ?? null,
    terminal_session_id: input.sessionId ?? null,
    workspace_id: input.workspaceId ?? null
  });
}

function logRendererDiagnostic(
  logger: DesktopLogger,
  input: DesktopRendererDiagnosticPayload
): void {
  const log = resolveLogMethod(logger, input.level ?? "info");
  log("renderer diagnostic", {
    renderer_details: input.details ?? {},
    renderer_event: input.event,
    renderer_source: input.source,
    workspace_id: input.workspaceId ?? null
  });
}

function resolveLogMethod(
  logger: DesktopLogger,
  level: DesktopRuntimeLogLevel
): (message: string, fields?: Record<string, unknown>) => void {
  switch (level) {
    case "debug":
      return logger.debug.bind(logger);
    case "warn":
      return logger.warn.bind(logger);
    case "error":
      return logger.error.bind(logger);
    default:
      return logger.info.bind(logger);
  }
}
