import { desktopIpcChannels } from "../../shared/contracts/ipc";
import type { DesktopRuntimeApi } from "../types";
import { invokeDesktopApi } from "./invoke";

export function createRuntimeDesktopApi(): DesktopRuntimeApi {
  return {
    getAgentSessionReplayPlayback() {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.getAgentSessionReplayPlayback
      );
    },
    getAgentSessionReplayStatus() {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.getAgentSessionReplayStatus
      );
    },
    getBackendConfig() {
      return invokeDesktopApi(desktopIpcChannels.runtime.getBackendConfig);
    },
    getBusinessEventStreamUrl() {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.getBusinessEventStreamUrl
      );
    },
    listWorkspaceAgentProbes(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.listWorkspaceAgentProbes,
        input
      );
    },
    launchAgentSessionReplay(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.launchAgentSessionReplay,
        input
      );
    },
    setAgentSessionReplayPlayback(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.setAgentSessionReplayPlayback,
        input
      );
    },
    sendAgentSessionReplayControl(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.sendAgentSessionReplayControl,
        input
      );
    },
    waitForAgentSessionReplay(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.waitForAgentSessionReplay,
        input
      );
    },
    logRendererDiagnostic(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.logRendererDiagnostic,
        input
      );
    },
    logTerminalDiagnostic(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.logTerminalDiagnostic,
        input
      );
    },
    getTerminalStreamUrl(input) {
      return invokeDesktopApi(
        desktopIpcChannels.runtime.getTerminalStreamUrl,
        input
      );
    }
  };
}
