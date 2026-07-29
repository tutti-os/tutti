import type { WorkspaceAppCenterViewState } from "@tutti-os/workspace-app-center";
import type { WorkspaceAppSurfacePresenter } from "../../workspace-app-center/services/workspaceAppSurfaceHost.interface.ts";
import {
  closeWorkspaceAppTab,
  openWorkspaceAppTab,
  readWorkspaceAppTabIds
} from "../../workspace-app-center/services/workspaceAppCenterTabs.ts";

export function createStandaloneAgentWorkspaceAppSurfacePresenter(input: {
  ensureWorkspaceAppPolling(): void;
  getViewState(workspaceId: string): WorkspaceAppCenterViewState;
  setViewState(request: {
    state: Partial<WorkspaceAppCenterViewState>;
    workspaceId: string;
  }): void;
  workspaceId: string;
}): WorkspaceAppSurfacePresenter {
  let activeAttemptId: number | null = null;
  let previousState: WorkspaceAppCenterViewState | null = null;
  return {
    beginOpen(attempt) {
      if (attempt.workspaceId !== input.workspaceId) {
        return;
      }
      activeAttemptId = attempt.attemptId;
      previousState = input.getViewState(input.workspaceId);
      input.ensureWorkspaceAppPolling();
      input.setViewState({
        state: openWorkspaceAppTab(previousState, attempt.appId),
        workspaceId: input.workspaceId
      });
    },
    close(request) {
      if (request.workspaceId !== input.workspaceId) {
        return;
      }
      input.setViewState({
        state: closeWorkspaceAppTab(
          input.getViewState(input.workspaceId),
          request.appId
        ),
        workspaceId: input.workspaceId
      });
    },
    isOpen(request) {
      return (
        request.workspaceId === input.workspaceId &&
        readWorkspaceAppTabIds(input.getViewState(input.workspaceId)).includes(
          request.appId
        )
      );
    },
    presentPrepared(request) {
      if (
        request.workspaceId !== input.workspaceId ||
        activeAttemptId !== request.attempt.attemptId ||
        input.getViewState(input.workspaceId).openAppId !== request.appId
      ) {
        return false;
      }
      activeAttemptId = null;
      previousState = null;
      return true;
    },
    rollbackOpen(attempt) {
      if (
        attempt.workspaceId !== input.workspaceId ||
        activeAttemptId !== attempt.attemptId ||
        input.getViewState(input.workspaceId).openAppId !== attempt.appId
      ) {
        return;
      }
      activeAttemptId = null;
      const rollbackState = previousState;
      previousState = null;
      input.setViewState({
        state:
          rollbackState ??
          closeWorkspaceAppTab(
            input.getViewState(input.workspaceId),
            attempt.appId
          ),
        workspaceId: input.workspaceId
      });
    }
  };
}
