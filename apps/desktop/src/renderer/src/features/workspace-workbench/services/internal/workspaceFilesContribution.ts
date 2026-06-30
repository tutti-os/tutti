import type { ReactNode } from "react";
import { createElement } from "react";
import type { WorkspaceFileManagerPersistedState } from "@tutti-os/workspace-file-manager/services";
import type {
  WorkbenchContribution,
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostNodeHeaderContext,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";
import type { IWorkspaceFileManagerService } from "@renderer/features/workspace-file-manager";
import { FileManagerOpenedReporter } from "../../../analytics/reporters/file-manager-opened/fileManagerOpenedReporter.ts";
import {
  createAnalyticsOpenedSourceParams,
  type AnalyticsOpenSource
} from "../../../analytics/reporters/openedSource.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { WorkspaceWorkbenchBodyRendererContext } from "../workspaceWorkbenchHostService.interface";
import {
  createWorkspaceFilesDockEntry,
  toWorkspaceFilesActivation,
  workspaceFilesNodeFrame,
  workspaceFilesNodeID
} from "./workspaceWorkbenchComposition.ts";
import { createTrackedWorkbenchNodeLease } from "./workspaceNodeLifecycleAnalytics.ts";

export function createWorkspaceFilesContribution(input: {
  filesLabel: string;
  icon: ReactNode;
  renderFilesNodeBody: (
    context: WorkspaceWorkbenchBodyRendererContext
  ) => ReactNode;
  renderTrafficLights: (
    context: Pick<
      WorkbenchHostNodeHeaderContext,
      "displayMode" | "windowActions"
    >
  ) => ReactNode;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceId: string;
}): WorkbenchContribution {
  return {
    dockEntries: [
      createWorkspaceFilesDockEntry({
        filesLabel: input.filesLabel,
        icon: input.icon
      })
    ],
    externalStateSource: createWorkspaceFilesExternalStateSource({
      workspaceFileManagerService: input.workspaceFileManagerService,
      workspaceId: input.workspaceId
    }),
    id: "workspace-files",
    nodes: [
      {
        createLease: (context) =>
          createTrackedWorkbenchNodeLease({
            openedParams: createAnalyticsOpenedSourceParams(
              resolveWorkspaceFilesOpenedSource(
                context.node?.data?.launchSource
              )
            ),
            openedReporter: FileManagerOpenedReporter,
            reporterService: input.reporterService
          }),
        frame: workspaceFilesNodeFrame,
        renderBody: (context) =>
          input.renderFilesNodeBody({
            activation: toWorkspaceFilesActivation(context.activation),
            externalNodeState:
              context.externalNodeState as WorkspaceFileManagerPersistedState | null,
            workspaceId: input.workspaceId
          }),
        renderHeader: (context) =>
          createElement(WorkspaceFilesWorkbenchHeader, {
            context,
            renderTrafficLights: input.renderTrafficLights
          }),
        title: input.filesLabel,
        typeId: workspaceFilesNodeID,
        window: {
          closable: true,
          defaultOpen: false,
          fullscreenHeaderMode: "persistent",
          minimizedDock: {
            kind: "snapshot"
          },
          minimizable: true
        }
      }
    ],
    onLaunchRequest: (request) => {
      if (request.typeId !== workspaceFilesNodeID) {
        return null;
      }

      return {
        defaultFrame: workspaceFilesNodeFrame,
        dockEntryId: request.dockEntryId ?? workspaceFilesNodeID,
        framePolicy: "cascade",
        instanceId: workspaceFilesNodeID,
        title: input.filesLabel,
        typeId: workspaceFilesNodeID
      };
    }
  };
}

function WorkspaceFilesWorkbenchHeader({
  context,
  renderTrafficLights
}: {
  context: WorkbenchHostNodeHeaderContext;
  renderTrafficLights: (
    context: Pick<
      WorkbenchHostNodeHeaderContext,
      "displayMode" | "windowActions"
    >
  ) => ReactNode;
}): ReactNode {
  return createElement(
    "div",
    {
      className:
        "flex h-full min-h-0 items-center gap-3 bg-[var(--background-panel)] px-3 pl-4"
    },
    renderTrafficLights(context),
    createElement(
      "div",
      {
        ...context.dragHandleProps,
        className:
          "flex h-full min-w-0 flex-1 cursor-grab items-center gap-2 active:cursor-grabbing"
      },
      createElement(
        "div",
        {
          className:
            "min-w-0 truncate text-[13px] font-semibold text-[var(--text-primary)]"
        },
        context.node.title
      )
    )
  );
}

function resolveWorkspaceFilesOpenedSource(
  launchSource: string | null | undefined
): AnalyticsOpenSource {
  switch (launchSource) {
    case "agent_command":
    case "dock":
    case "issue_manager":
    case "keyboard":
    case "launchpad":
      return launchSource;
    default:
      return "restore";
  }
}

function createWorkspaceFilesExternalStateSource(input: {
  workspaceFileManagerService: IWorkspaceFileManagerService;
  workspaceId: string;
}): WorkbenchHostExternalStateSource<
  WorkspaceFileManagerPersistedState | null,
  null
> {
  return {
    getNodeState(request) {
      if (!isWorkspaceFilesExternalStateRequest(request)) {
        return null;
      }
      return input.workspaceFileManagerService.getSnapshotState(
        input.workspaceId
      );
    },
    getSnapshotNodeState(request) {
      if (!isWorkspaceFilesExternalStateRequest(request)) {
        return null;
      }
      return input.workspaceFileManagerService.getSnapshotState(
        input.workspaceId
      );
    },
    getWorkspaceState() {
      return null;
    },
    subscribe(listener) {
      return input.workspaceFileManagerService.subscribe(
        input.workspaceId,
        listener
      );
    }
  };
}

function isWorkspaceFilesExternalStateRequest(
  request: WorkbenchHostExternalStateLookupInput
): boolean {
  return request.typeId === workspaceFilesNodeID;
}
