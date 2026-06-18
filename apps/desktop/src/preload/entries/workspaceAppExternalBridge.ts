import type { DesktopWorkspaceAppContext } from "../../shared/contracts/ipc";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalBridge,
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectInput,
  TuttiExternalFileSelectResult,
  TuttiExternalLogInput,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult,
  TuttiExternalSettingsOpenInput,
  TuttiExternalWorkspaceOpenFeatureInput
} from "@tutti-os/workspace-external-core/contracts";
import { normalizeTuttiExternalLogInput } from "@tutti-os/workspace-external-core/core";

export interface WorkspaceAppExternalBridgeDependencies {
  appContext: {
    get(): Promise<DesktopWorkspaceAppContext>;
    subscribe(
      listener: (context: DesktopWorkspaceAppContext) => void
    ): () => void;
  };
  invoke<TResult>(channel: string, payload?: unknown): Promise<TResult>;
  isUserActivationActive(): boolean;
  send(channel: string, payload?: unknown): void;
}

export const workspaceAppExternalChannels = {
  atQuery: "workspace-app-at:query",
  filesOpen: "workspace-app-files:open",
  filesSelect: "workspace-app-files:select",
  logsWrite: "workspace-app-logs:write",
  permissionsRequest: "workspace-app-permissions:request",
  settingsOpen: "workspace-app-settings:open",
  workspaceFeatureOpen: "workspace-app-feature:open"
} as const;

export function createWorkspaceAppExternalBridge(
  dependencies: WorkspaceAppExternalBridgeDependencies
): TuttiExternalBridge {
  return {
    app: {
      getContext() {
        return dependencies.appContext.get();
      },
      subscribe(listener) {
        return dependencies.appContext.subscribe(listener);
      }
    },
    at: {
      query(input: TuttiExternalAtQueryInput) {
        return dependencies.invoke<TuttiExternalAtQueryResult[]>(
          workspaceAppExternalChannels.atQuery,
          input
        );
      }
    },
    files: {
      select(input?: TuttiExternalFileSelectInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "files.select"
        );
        return dependencies.invoke<TuttiExternalFileSelectResult>(
          workspaceAppExternalChannels.filesSelect,
          input ?? {}
        );
      },
      open(input: TuttiExternalFileOpenInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "files.open"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.filesOpen,
          input
        );
      }
    },
    permissions: {
      request(input: TuttiExternalPermissionRequestInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "permissions.request"
        );
        return dependencies.invoke<TuttiExternalPermissionRequestResult>(
          workspaceAppExternalChannels.permissionsRequest,
          input
        );
      }
    },
    settings: {
      open(input?: TuttiExternalSettingsOpenInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "settings.open"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.settingsOpen,
          input ?? {}
        );
      }
    },
    workspace: {
      openFeature(input: TuttiExternalWorkspaceOpenFeatureInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "workspace.openFeature"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.workspaceFeatureOpen,
          input
        );
      }
    },
    logs: {
      write(input: TuttiExternalLogInput) {
        try {
          dependencies.send(
            workspaceAppExternalChannels.logsWrite,
            normalizeTuttiExternalLogInput(input)
          );
        } catch {
          // Fire-and-forget: invalid app payloads are silently ignored.
        }
      }
    }
  };
}

export function requireUserActivation(
  isActive: boolean,
  operation: string
): void {
  if (!isActive) {
    throw new Error(`${operation} requires a user action.`);
  }
}
