import type { DesktopRuntimeApi } from "@preload/types";
import type {
  WorkspaceTerminalLoginLaunchHandler,
  WorkspaceTerminalLoginStartupResult
} from "@renderer/features/workspace-agent/services/workspaceTerminalLoginLaunchCoordinator.ts";
import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import { createTerminalStartupInputGate } from "./terminalStartupInputGate.ts";
import { getWorkspaceTerminalSurfaceRuntime } from "./workspaceTerminalSurfaceRuntime.ts";

export function createStandaloneAgentTerminalLoginPresenter(input: {
  closeTab(tabId: string): void;
  contributions: readonly WorkbenchContribution[];
  openTab(sessionId: string): string | null;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
}): WorkspaceTerminalLoginLaunchHandler {
  const terminalSurfaceRuntime = input.contributions
    .map((contribution) => getWorkspaceTerminalSurfaceRuntime(contribution))
    .find((candidate) => candidate !== null);

  return async (request) => {
    if (!terminalSurfaceRuntime) {
      throw new Error("Terminal login is unavailable in this window.");
    }
    const startupGate = request.startupAction
      ? createTerminalStartupInputGate({
          commandName: request.startupAction.commandName,
          readyText: request.startupAction.readyText,
          transport: terminalSurfaceRuntime.feature.transport
        })
      : null;
    let sessionId: string | null = null;
    try {
      const session = await terminalSurfaceRuntime.createSession({
        cwd: request.cwd,
        initialInput: /[\r\n]$/u.test(request.command)
          ? request.command
          : `${request.command}\n`
      });
      sessionId = session.sessionId;
      const tabId = input.openTab(session.sessionId);
      if (!tabId) {
        throw new Error("Terminal login did not open the Agent tool panel.");
      }

      let startupCompletion: Promise<WorkspaceTerminalLoginStartupResult>;
      if (startupGate) {
        startupCompletion = startupGate.arm(session.sessionId);
        void startupCompletion.then((result) =>
          input.runtimeApi
            .logTerminalDiagnostic({
              details: { result },
              event: "agent.gui.terminal-login.startup-input",
              level: result === "submitted" ? "info" : "warn",
              nodeId: tabId,
              workspaceId: request.workspaceId
            })
            .catch(() => undefined)
        );
      } else {
        startupCompletion = Promise.resolve("not_required");
      }

      return {
        close: () => {
          startupGate?.cancel();
          input.closeTab(tabId);
          void terminalSurfaceRuntime.feature.launchService
            .terminate({ sessionId: session.sessionId })
            .catch(() => undefined);
        },
        startupCompletion
      };
    } catch (error) {
      startupGate?.cancel();
      if (sessionId) {
        void terminalSurfaceRuntime.feature.launchService
          .terminate({ sessionId })
          .catch(() => undefined);
      }
      throw error;
    }
  };
}
