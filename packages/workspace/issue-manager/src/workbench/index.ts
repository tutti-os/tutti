import { createElement, type ReactNode } from "react";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import type {
  WorkbenchContribution,
  WorkbenchFrame,
  WorkbenchHostActivation,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateSource,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import type {
  IssueManagerNodeState,
  IssueManagerOpenSource
} from "../contracts/index.ts";
import type { IssueManagerDiagnostics } from "../internal/issueManagerDiagnostics.ts";
import {
  normalizeIssueManagerNodeState,
  resolveIssueManagerExpandedFrame,
  shouldAutoCollapseIssueManagerSidebar,
  type IssueManagerFeature
} from "../core/index.ts";
import type { IssueManagerControllerService } from "../services/issueManagerControllerService.interface.ts";
import {
  dispatchIssueManagerTaskListCollapsed,
  IssueManagerNode,
  IssueManagerNodeHeader,
  type IssueManagerNodeOpenRequest
} from "../ui/IssueManagerNode.tsx";
import type { IssueManagerLatestRunStatusRenderer } from "../ui/latestRunStatusRenderer.ts";
export {
  defaultIssueManagerNodeFrame,
  defaultIssueManagerWorkbenchTypeId
} from "./constants.ts";
export {
  issueManagerOpenActivationType,
  readIssueManagerOpenActivationPayload,
  type IssueManagerOpenActivationPayload
} from "./openActivation.ts";
import {
  defaultIssueManagerNodeFrame,
  defaultIssueManagerWorkbenchTypeId
} from "./constants.ts";
import { readIssueManagerOpenActivationPayload } from "./openActivation.ts";

export interface IssueManagerExternalWorkspaceState {
  workspaceId?: string | null;
}

export interface CreateIssueManagerWorkbenchNodeDefinitionInput {
  diagnostics?: IssueManagerDiagnostics | null;
  emptyIllustration?: ReactNode;
  feature: IssueManagerFeature;
  frame?: WorkbenchFrame;
  onStateChange?: (input: {
    instanceId: string;
    instanceKey?: string | null;
    nodeId: string;
    state: IssueManagerNodeState;
    workspaceState: IssueManagerExternalWorkspaceState;
  }) => void;
  resolveRichTextTriggerProviders?: (input: {
    surface: "issue" | "task";
    workspaceId: string;
  }) => readonly RichTextTriggerProvider[];
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  service?: IssueManagerControllerService;
  title?: string;
  typeId?: string;
}

export interface CreateIssueManagerWorkbenchLaunchHandlerInput {
  frame?: WorkbenchFrame;
  title?: string;
  typeId?: string;
}

export interface CreateIssueManagerDockEntryInput {
  dockIcon?: ReactNode;
  feature: IssueManagerFeature;
  id?: string;
  order?: number;
  separatorAfter?: boolean;
  sectionId?: string;
  typeId?: string;
}

export interface CreateIssueManagerWorkbenchContributionInput {
  contributionId?: string;
  dockEntry?: Omit<CreateIssueManagerDockEntryInput, "feature">;
  externalStateSource?: WorkbenchHostExternalStateSource<
    Partial<IssueManagerNodeState> | null,
    IssueManagerExternalWorkspaceState
  >;
  feature: IssueManagerFeature;
  node?: Omit<CreateIssueManagerWorkbenchNodeDefinitionInput, "feature">;
  typeId?: string;
}

export function createIssueManagerWorkbenchNodeDefinition<
  TExternalWorkspaceState extends IssueManagerExternalWorkspaceState =
    IssueManagerExternalWorkspaceState
>({
  emptyIllustration,
  diagnostics,
  feature,
  frame = defaultIssueManagerNodeFrame,
  onStateChange,
  resolveRichTextTriggerProviders,
  renderLatestRunStatus,
  service,
  title,
  typeId = defaultIssueManagerWorkbenchTypeId
}: CreateIssueManagerWorkbenchNodeDefinitionInput): WorkbenchHostNodeDefinition<
  Partial<IssueManagerNodeState> | null,
  TExternalWorkspaceState
> {
  return {
    frame,
    instance: {
      mode: "single"
    },
    renderBody: (context) =>
      createElement(IssueManagerNode, {
        emptyIllustration,
        diagnostics,
        feature,
        nodeId: context.node.id,
        openRequest: toIssueManagerNodeOpenRequest(context.activation),
        openSource: resolveIssueManagerOpenSource(
          context.node.data.launchSource
        ),
        onStateChange: onStateChange
          ? (state) =>
              onStateChange({
                instanceId: context.instanceId,
                instanceKey: context.instanceKey ?? null,
                nodeId: context.node.id,
                state,
                workspaceState: context.externalWorkspaceState
              })
          : undefined,
        renderLatestRunStatus,
        resolveRichTextTriggerProviders,
        service,
        state: context.externalNodeState,
        workspaceId: context.externalWorkspaceState.workspaceId ?? ""
      }),
    renderHeader: ({
      defaultActions,
      dragHandleProps,
      externalNodeState,
      externalWorkspaceState,
      instanceId,
      instanceKey,
      isFocused,
      node,
      surfaceSize,
      windowActions
    }) => {
      const nodeState = normalizeIssueManagerNodeState(externalNodeState);
      const isSidebarAutoCollapsed = shouldAutoCollapseIssueManagerSidebar(
        node.frame.width
      );
      const isSidebarCollapsed =
        nodeState.taskListCollapsed === true || isSidebarAutoCollapsed;
      const persistTaskListCollapsed = (collapsed: boolean) => {
        onStateChange?.({
          instanceId,
          instanceKey: instanceKey ?? null,
          nodeId: node.id,
          state: {
            ...nodeState,
            taskListCollapsed: collapsed
          },
          workspaceState: externalWorkspaceState
        });
      };
      const applyTaskListCollapsed = (collapsed: boolean) => {
        dispatchIssueManagerTaskListCollapsed({
          collapsed,
          nodeId: node.id,
          workspaceId: externalWorkspaceState.workspaceId ?? ""
        });
        persistTaskListCollapsed(collapsed);
      };

      return createElement(IssueManagerNodeHeader, {
        activeTopicId: nodeState.activeTopicId ?? null,
        copy: feature.i18n,
        defaultActions,
        displayMode: node.displayMode,
        isSidebarAutoCollapsed,
        isSidebarCollapsed,
        nodeId: node.id,
        title: node.title,
        windowActions: {
          close: windowActions.close,
          minimize: windowActions.minimize,
          toggleDisplayMode: windowActions.toggleDisplayMode
        },
        workspaceId: externalWorkspaceState.workspaceId ?? "",
        ...dragHandleProps,
        onPointerDown: (event) => {
          dragHandleProps.onPointerDown?.(event);
          if (!isFocused) {
            windowActions.focus();
          }
        },
        onToggleSidebar: (nextCollapsed) => {
          if (
            isSidebarCollapsed &&
            nextCollapsed === false &&
            node.displayMode !== "fullscreen"
          ) {
            windowActions.resize(
              resolveIssueManagerExpandedFrame(node.frame, surfaceSize.width)
            );
            applyTaskListCollapsed(false);
            return;
          }

          applyTaskListCollapsed(nextCollapsed);
        }
      });
    },
    title: title ?? feature.i18n.t("title"),
    typeId,
    window: {
      closable: true,
      defaultOpen: false,
      minimizedDock: {
        kind: "snapshot"
      },
      minimizable: true,
      restoreOnLoad: true
    }
  };
}

function resolveIssueManagerOpenSource(
  launchSource: string | null | undefined
): IssueManagerOpenSource {
  switch (launchSource) {
    case "agent_command":
    case "command":
    case "dock":
    case "keyboard":
    case "launchpad":
      return launchSource;
    default:
      return "restore";
  }
}

function toIssueManagerNodeOpenRequest(
  activation: WorkbenchHostActivation | null
): IssueManagerNodeOpenRequest | null {
  const payload = readIssueManagerOpenActivationPayload(activation);
  if (!payload) {
    return null;
  }
  return {
    ...payload,
    requestId: String(activation?.sequence ?? "")
  };
}

export function createIssueManagerDockEntry({
  dockIcon,
  feature,
  id,
  order,
  separatorAfter,
  sectionId,
  typeId = defaultIssueManagerWorkbenchTypeId
}: CreateIssueManagerDockEntryInput): WorkbenchHostDockEntry {
  return {
    icon: dockIcon ?? null,
    id: id ?? typeId,
    label: feature.i18n.t("dockLabel"),
    launchBehavior: "enabled",
    matchNode: (node) => node.data.typeId === typeId,
    order,
    resolvePopupItem: ({ node }) => ({
      revision: node.title,
      title: node.title
    }),
    separatorAfter,
    sectionId,
    typeId,
    visibility: "always"
  };
}

export function createIssueManagerDockIconImage(src: string): ReactNode {
  return createElement("img", {
    alt: "",
    "aria-hidden": "true",
    "data-issue-manager-dock-icon": "true",
    draggable: false,
    src
  });
}

export function createIssueManagerWorkbenchLaunchHandler({
  frame = defaultIssueManagerNodeFrame,
  title,
  typeId = defaultIssueManagerWorkbenchTypeId
}: CreateIssueManagerWorkbenchLaunchHandlerInput = {}): (
  request: WorkbenchHostLaunchRequest
) => Promise<WorkbenchHostLaunchResult | null> {
  return (request) => {
    if (request.typeId !== typeId) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      defaultFrame: frame,
      dockEntryId: request.dockEntryId ?? typeId,
      framePolicy: "cascade",
      instanceId: typeId,
      title,
      typeId
    });
  };
}

export function createIssueManagerWorkbenchContribution({
  contributionId,
  dockEntry,
  externalStateSource,
  feature,
  node,
  typeId = defaultIssueManagerWorkbenchTypeId
}: CreateIssueManagerWorkbenchContributionInput): WorkbenchContribution {
  return {
    dockEntries: [
      createIssueManagerDockEntry({
        ...dockEntry,
        feature,
        typeId
      })
    ],
    externalStateSource,
    id: contributionId ?? typeId,
    nodes: [
      createIssueManagerWorkbenchNodeDefinition({
        ...node,
        feature,
        typeId
      })
    ],
    onLaunchRequest: createIssueManagerWorkbenchLaunchHandler({
      frame: node?.frame,
      title: node?.title,
      typeId
    })
  };
}
