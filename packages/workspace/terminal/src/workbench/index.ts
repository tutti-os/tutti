import { createElement, type PointerEvent, type ReactNode } from "react";
import type {
  WorkbenchContribution,
  WorkbenchFrame,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateSource,
  WorkbenchHostLaunchRequest,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeCloseDecision,
  WorkbenchHostNodeCloseRequest,
  WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import type {
  TerminalCloseGuardResult,
  TerminalHeaderAccessoryRenderer,
  TerminalLaunchInput,
  TerminalNodeExternalState,
  TerminalPreviewChangeHandler
} from "../contracts/index.ts";
import { closeTerminalSession } from "../core/index.ts";
import type { TerminalNodeFeature } from "../core/feature.ts";
import { acquireTerminalSessionController } from "../core/sessionController.ts";
import { resolveTerminalWorkbenchBodyProps } from "./bodyProps.ts";
import { resolveTerminalLaunchAnalyticsTrigger } from "./launchAnalytics.ts";
import { resolveTerminalWindowCloseEffect } from "./windowCloseEffect.ts";
import { TerminalNode, TerminalNodeHeader } from "../react/TerminalNode.tsx";

export interface TerminalWorkbenchIntent {
  cwd?: string | null;
  initialInput?: string | null;
  profileId?: string | null;
}

export interface CreateTerminalWorkbenchNodeDefinitionInput {
  feature: TerminalNodeFeature;
  frame?: WorkbenchFrame;
  headerAccessory?: TerminalHeaderAccessoryRenderer;
  onPreviewChange?: TerminalPreviewChangeHandler;
  title?: string;
  typeId?: string;
}

export type TerminalWorkbenchLaunchInputResolver = (
  request: WorkbenchHostLaunchRequest
) =>
  | Promise<Partial<Omit<TerminalLaunchInput, "reason" | "workspaceId">>>
  | Partial<Omit<TerminalLaunchInput, "reason" | "workspaceId">>;

export interface CreateTerminalWorkbenchLaunchHandlerInput {
  feature: TerminalNodeFeature;
  frame?: WorkbenchFrame;
  resolveLaunchInput?: TerminalWorkbenchLaunchInputResolver;
  typeId?: string;
}

export interface CreateTerminalDockEntryInput {
  dockIcon?: ReactNode;
  feature: TerminalNodeFeature;
  id?: string;
  order?: number;
  sectionId?: string;
  typeId?: string;
}

export interface TerminalWorkbenchContributionCloseFailure {
  error: unknown;
  sessionId: string;
  status?: TerminalNodeExternalState["status"];
}

export interface CreateTerminalWorkbenchContributionInput {
  contributionId?: string;
  dockEntry?: Omit<CreateTerminalDockEntryInput, "feature">;
  externalStateSource?: WorkbenchHostExternalStateSource<
    TerminalNodeExternalState | null,
    unknown
  >;
  feature: TerminalNodeFeature;
  getTerminalState?: (sessionId: string) => TerminalNodeExternalState | null;
  node?: Omit<CreateTerminalWorkbenchNodeDefinitionInput, "feature">;
  onCloseFailure?: (failure: TerminalWorkbenchContributionCloseFailure) => void;
  onConfirmClose?: (
    guard: TerminalCloseGuardResult
  ) => Promise<boolean> | boolean;
  resolveLaunchInput?: TerminalWorkbenchLaunchInputResolver;
  shouldCloseAfterCloseFailure?: (
    failure: TerminalWorkbenchContributionCloseFailure
  ) => boolean;
  typeId?: string;
}

export const defaultTerminalWorkbenchTypeId = "workspace-terminal";

const defaultTerminalNodeFrame: WorkbenchFrame = {
  height: 520,
  width: 860,
  x: 260,
  y: 140
};

export function createTerminalWorkbenchNodeDefinition({
  feature,
  frame = defaultTerminalNodeFrame,
  headerAccessory,
  onPreviewChange,
  title,
  typeId = defaultTerminalWorkbenchTypeId
}: CreateTerminalWorkbenchNodeDefinitionInput): WorkbenchHostNodeDefinition<TerminalNodeExternalState> {
  return {
    frame,
    instance: {
      mode: "multi"
    },
    renderBody: (context) =>
      createElement(
        TerminalNode,
        resolveTerminalWorkbenchBodyProps({ context, feature, onPreviewChange })
      ),
    createLease: ({ node }) => {
      const sessionId = node.data.instanceKey ?? null;
      if (!sessionId) {
        return null;
      }
      const controller = acquireTerminalSessionController({
        feature,
        nodeId: node.id,
        sessionId
      });
      controller.retain();
      return {
        release() {
          controller.release();
        }
      };
    },
    getWindowCloseEffect: ({ externalNodeState, node }) =>
      resolveTerminalWindowCloseEffect({
        closeGuard: feature.closeGuard,
        description: feature.i18n.t("closeGuard.description"),
        externalNodeState,
        nodeId: node.id,
        sessionId: node.data.instanceKey ?? null,
        title: node.title,
        typeId
      }),
    renderHeader: ({
      defaultActions,
      dragHandleProps,
      externalNodeState,
      isFocused,
      node,
      windowActions
    }) =>
      createElement(TerminalNodeHeader, {
        defaultActions,
        externalState: externalNodeState,
        feature,
        headerAccessory,
        onCloseRequest: () => windowActions.close(),
        sessionId: node.data.instanceKey ?? null,
        ...dragHandleProps,
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
          dragHandleProps.onPointerDown?.(event);
          if (!isFocused) {
            windowActions.focus();
          }
        }
      }),
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

export function createTerminalDockEntry({
  dockIcon,
  feature,
  id,
  order,
  sectionId,
  typeId = defaultTerminalWorkbenchTypeId
}: CreateTerminalDockEntryInput): WorkbenchHostDockEntry {
  return {
    icon: dockIcon ?? createElement(DefaultTerminalDockIcon),
    id: id ?? typeId,
    label: feature.i18n.t("dockLabel"),
    launchBehavior: "enabled",
    matchNode: (node) => node.data.typeId === typeId,
    order,
    resolvePopupItem: ({ node }) => {
      const subtitle = node.data.instanceKey ?? node.data.instanceId;
      return {
        revision: `${node.title}\n${subtitle}`,
        subtitle,
        title: node.title
      };
    },
    sectionId,
    typeId,
    visibility: "always"
  };
}

export function createTerminalWorkbenchLaunchHandler({
  feature,
  frame = defaultTerminalNodeFrame,
  resolveLaunchInput,
  typeId = defaultTerminalWorkbenchTypeId
}: CreateTerminalWorkbenchLaunchHandlerInput): (
  request: WorkbenchHostLaunchRequest
) => Promise<WorkbenchHostLaunchResult | null> {
  return async (request) => {
    if (request.typeId !== typeId) {
      return null;
    }

    const resolved = (await resolveLaunchInput?.(request)) ?? {};
    const descriptor = await feature.launchService.create({
      cwd: resolved.cwd,
      initialInput: resolved.initialInput,
      profileId: resolved.profileId,
      reason: request.reason === "dock" ? "dock" : "intent",
      workspaceId: request.workspaceId
    });

    return {
      activation: {
        payload: {
          trigger: resolveTerminalLaunchAnalyticsTrigger(request)
        },
        type: "terminal-launch"
      },
      defaultFrame: frame,
      dockEntryId: request.dockEntryId ?? typeId,
      framePolicy: "cascade",
      instanceId: descriptor.sessionId,
      instanceKey: descriptor.sessionId,
      title: descriptor.title,
      typeId
    };
  };
}

export function createTerminalWorkbenchContribution({
  contributionId,
  dockEntry,
  externalStateSource,
  feature,
  getTerminalState,
  node,
  onCloseFailure,
  onConfirmClose,
  resolveLaunchInput,
  shouldCloseAfterCloseFailure,
  typeId = defaultTerminalWorkbenchTypeId
}: CreateTerminalWorkbenchContributionInput): WorkbenchContribution {
  return {
    dockEntries: [
      createTerminalDockEntry({
        ...dockEntry,
        feature,
        typeId
      })
    ],
    externalStateSource,
    id: contributionId ?? typeId,
    nodes: [
      createTerminalWorkbenchNodeDefinition({
        ...node,
        feature,
        typeId
      })
    ],
    onLaunchRequest: createTerminalWorkbenchLaunchHandler({
      feature,
      frame: node?.frame,
      resolveLaunchInput,
      typeId
    }),
    onNodeCloseRequest: onConfirmClose
      ? (request) =>
          handleTerminalContributionNodeCloseRequest({
            feature,
            getTerminalState,
            onCloseFailure,
            onConfirmClose,
            request,
            shouldCloseAfterCloseFailure,
            typeId
          })
      : undefined
  };
}

async function handleTerminalContributionNodeCloseRequest(input: {
  feature: TerminalNodeFeature;
  getTerminalState?: (sessionId: string) => TerminalNodeExternalState | null;
  onCloseFailure?: (failure: TerminalWorkbenchContributionCloseFailure) => void;
  onConfirmClose: (
    guard: TerminalCloseGuardResult
  ) => Promise<boolean> | boolean;
  request: WorkbenchHostNodeCloseRequest;
  shouldCloseAfterCloseFailure?: (
    failure: TerminalWorkbenchContributionCloseFailure
  ) => boolean;
  typeId: string;
}): Promise<WorkbenchHostNodeCloseDecision | void> {
  if (input.request.typeId !== input.typeId) {
    return undefined;
  }

  const sessionId = input.request.instanceKey ?? input.request.instanceId;
  const terminalState = input.getTerminalState?.(sessionId) ?? null;
  try {
    const result = await closeTerminalSession({
      confirm: input.onConfirmClose,
      feature: input.feature,
      sessionId,
      status: terminalState?.status
    });
    return result === "closed" ? "close" : "keep-open";
  } catch (error) {
    const failure = {
      error,
      sessionId,
      status: terminalState?.status
    };
    input.onCloseFailure?.(failure);
    return input.shouldCloseAfterCloseFailure?.(failure)
      ? "close"
      : "keep-open";
  }
}

function DefaultTerminalDockIcon() {
  return createElement(
    "span",
    {
      "aria-hidden": "true",
      className: "workspace-terminal__dock-icon"
    },
    ">"
  );
}
