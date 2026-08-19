import { app, shell } from "electron";
import {
  desktopIpcChannels,
  type DesktopTerminalStreamUrlRequest,
  type DesktopBackendConfig,
  type DesktopRendererDiagnosticPayload,
  type DesktopRuntimeLogLevel,
  type DesktopTerminalDiagnosticPayload
} from "../../shared/contracts/ipc";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopLogger } from "../logging";
import {
  resolveDesktopDaemonBaseUrl,
  resolveDesktopBusinessEventStreamUrl,
  resolveDesktopTerminalStreamUrl,
  type DesktopDaemonEndpoint
} from "../transport/paths";
import { listDesktopWorkspaceAgentProbes } from "../agentProviderUsageProbe";
import type { DesktopFileDialogAccess } from "../host/desktopFileDialogAccess.ts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import {
  AGENT_SESSION_RECORDING_FLAG,
  isFeatureEnabled
} from "../../shared/featureFlags/catalog.ts";
import { installAgentSessionReplayRuntimeComposition } from "../agentSessionReplayRuntimeComposition.ts";
import { registerDesktopIpcHandler } from "./handle";
import { resolveOwnerWindowFromEvent } from "./ownerWindow.ts";

export function registerRuntimeIpc(
  endpoint: DesktopDaemonEndpoint,
  logger: DesktopLogger,
  tuttidClient: Pick<
    TuttidClient,
    | "getAgentSessionReplayTransportPlayback"
    | "importAgentSessionCassettes"
    | "prepareAgentSessionReplayWorkspace"
    | "probeAgentTargetAccountUsage"
    | "updateAgentSessionReplayTransportPlayback"
  >,
  fileDialogs: Pick<DesktopFileDialogAccess, "selectUploadFiles">,
  preferences: Pick<DesktopHostPreferencesState, "getFeatureFlags">
): { dispose(): void; shutdown(): Promise<void> } {
  const replayProcessManager = installAgentSessionReplayRuntimeComposition({
    electronEntry: app.isPackaged ? null : app.getAppPath(),
    electronExecutable: process.execPath,
    enabled: isFeatureEnabled(
      preferences.getFeatureFlags(),
      AGENT_SESSION_RECORDING_FLAG
    ),
    environment: process.env,
    fileDialogs,
    isPackaged: app.isPackaged,
    logger,
    nodeExecutable: process.env.npm_node_execpath?.trim() || "node",
    registerIpcHandler: registerDesktopIpcHandler,
    resolveOwnerWindow: resolveOwnerWindowFromEvent,
    showItemInFolder: (path) => shell.showItemInFolder(path),
    tuttidClient
  });
  registerDesktopIpcHandler(desktopIpcChannels.runtime.getBackendConfig, () =>
    resolveBackendConfig(endpoint)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.getBusinessEventStreamUrl,
    () => resolveBusinessEventStreamUrl(endpoint)
  );
  registerDesktopIpcHandler(
    desktopIpcChannels.runtime.listWorkspaceAgentProbes,
    (_event, input) =>
      listDesktopWorkspaceAgentProbes(input, {
        probeAgentTargetAccountUsage: (agentTargetId) =>
          tuttidClient.probeAgentTargetAccountUsage(agentTargetId)
      })
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
  return (
    replayProcessManager ?? {
      dispose() {},
      async shutdown() {}
    }
  );
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
