import type { DesktopRuntimeApi } from "@preload/types";
import type {
  WorkspaceTerminalLoginLaunchHandler,
  WorkspaceTerminalLoginStartupResult
} from "@renderer/features/workspace-agent/services/workspaceTerminalLoginLaunchCoordinator.ts";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { createTerminalStartupInputGate } from "./terminalStartupInputGate.ts";
import { getWorkspaceTerminalSurfaceRuntime } from "./workspaceTerminalSurfaceRuntime.ts";
import { defaultWorkspaceTerminalWorkbenchTypeId } from "./workspaceWorkbenchNodeIds.ts";

export function createWorkbenchTerminalLoginPresenter(input: {
  contributions: readonly WorkbenchContribution[];
  host: WorkbenchHostHandle;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
}): WorkspaceTerminalLoginLaunchHandler {
  const terminalSurfaceRuntime = input.contributions
    .map((contribution) => getWorkspaceTerminalSurfaceRuntime(contribution))
    .find((candidate) => candidate !== null);

  return async (request) => {
    if (request.startupAction && !terminalSurfaceRuntime) {
      throw new Error("Terminal startup action is unavailable.");
    }
    const startupGate =
      request.startupAction && terminalSurfaceRuntime
        ? createTerminalStartupInputGate({
            commandName: request.startupAction.commandName,
            readyText: request.startupAction.readyText,
            transport: terminalSurfaceRuntime.feature.transport
          })
        : null;
    try {
      const nodeId = await input.host.launchNode({
        payload: {
          cwd: request.cwd,
          initialInput: /[\r\n]$/u.test(request.command)
            ? request.command
            : `${request.command}\n`
        },
        reason: "host",
        typeId: defaultWorkspaceTerminalWorkbenchTypeId
      });
      if (!nodeId) {
        throw new Error("Terminal login did not open a workbench node.");
      }

      let startupCompletion: Promise<WorkspaceTerminalLoginStartupResult>;
      if (startupGate) {
        const sessionId = input.host
          .getSnapshot()
          .nodes.find((node) => node.id === nodeId)?.data.instanceKey;
        if (!sessionId) {
          startupGate.cancel();
          throw new Error("Terminal login session is unavailable.");
        }
        startupCompletion = startupGate.arm(sessionId);
        void startupCompletion.then((result) =>
          input.runtimeApi
            .logTerminalDiagnostic({
              details: { result },
              event: "agent.gui.terminal-login.startup-input",
              level: result === "submitted" ? "info" : "warn",
              nodeId,
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
          input.host.closeNode(nodeId);
        },
        startupCompletion
      };
    } catch (error) {
      startupGate?.cancel();
      throw error;
    }
  };
}
