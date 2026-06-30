import { createElement, type ReactNode } from "react";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { getTuttidProtocolErrorCode } from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createTerminalNodeFeature } from "@tutti-os/workspace-terminal";
import { TerminalDockPreview } from "@tutti-os/workspace-terminal/react";
import type {
  TerminalNodeExternalState,
  TerminalPreviewChange,
  TerminalPreviewSnapshot
} from "@tutti-os/workspace-terminal/contracts";
import {
  createTerminalWorkbenchContribution,
  type TerminalWorkbenchIntent
} from "@tutti-os/workspace-terminal/workbench";
import type {
  WorkbenchContribution,
  WorkbenchHostCloseDialogRequest,
  WorkbenchHostDockPopupItemInput,
  WorkbenchHostExternalStateSource,
  WorkbenchHostNodeHeaderContext
} from "@tutti-os/workbench-surface";
import type {
  DesktopHostFilesApi,
  DesktopPlatformApi,
  DesktopRuntimeApi
} from "@preload/types";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  workspaceWorkbenchDesktopI18nKeys,
  type WorkspaceWorkbenchDesktopI18nRuntime
} from "../../../../../../shared/i18n/index.ts";
import { createDesktopWorkspaceTerminalAdapter } from "./adapters/desktopWorkspaceTerminalAdapter";
import { createTerminalCloseDialogRequest } from "./workspaceCloseDialogRequests.ts";
import {
  createDesktopTerminalDiagnostics,
  logDesktopTerminalEvent
} from "./desktopTerminalLogging.ts";
import {
  closeWindowTerminalNodes,
  shouldCloseTerminalNodeAfterCloseFailure
} from "./terminalWindowClose.ts";
import { requestWorkspaceBrowserLaunch } from "../workspaceBrowserLaunchCoordinator.ts";
import {
  createTerminalAnalyticsDiagnostics,
  createTerminalSurfaceAnalytics,
  resolveTerminalOpenedParams
} from "./workspaceTerminalAnalytics.ts";
import { defaultWorkspaceTerminalWorkbenchTypeId } from "./workspaceTerminalWorkbenchConstants.ts";

export function createWorkspaceTerminalContribution(input: {
  appI18n: I18nRuntime<string>;
  confirmCloseGuard: (
    request: WorkbenchHostCloseDialogRequest
  ) => Promise<boolean> | boolean;
  dockIcon: ReactNode;
  hostFilesApi: DesktopHostFilesApi;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  tuttidClient: TuttidClient;
  platformApi: Pick<DesktopPlatformApi, "resolveDroppedPaths">;
  reporterService?: Pick<IReporterService, "trackEvents">;
  renderTrafficLights: (
    context: Pick<
      WorkbenchHostNodeHeaderContext,
      "displayMode" | "windowActions"
    >
  ) => ReactNode;
  runtimeApi: DesktopRuntimeApi;
  workspaceId: string;
}): WorkbenchContribution {
  const previewStore = createWorkspaceTerminalPreviewStore();
  const terminalAnalytics = createTerminalSurfaceAnalytics({
    reporterService: input.reporterService
  });
  const terminalAdapter = createDesktopWorkspaceTerminalAdapter({
    hostFilesApi: input.hostFilesApi,
    tuttidClient: input.tuttidClient,
    openBrowserUrl: requestWorkspaceBrowserLaunch,
    platformApi: input.platformApi,
    runtimeApi: input.runtimeApi,
    terminalTitle: input.i18n.t(
      workspaceWorkbenchDesktopI18nKeys.nodes.terminal
    ),
    workspaceId: input.workspaceId
  });
  const feature = createTerminalNodeFeature({
    closeGuard: terminalAdapter.closeGuard,
    diagnostics: createTerminalAnalyticsDiagnostics({
      analytics: terminalAnalytics,
      baseDiagnostics: createDesktopTerminalDiagnostics({
        runtimeApi: input.runtimeApi,
        workspaceId: input.workspaceId
      })
    }),
    dropInput: terminalAdapter.dropInput,
    i18n: input.appI18n,
    launchService: terminalAdapter.launchService,
    linkHandler: terminalAdapter.linkHandler,
    transport: terminalAdapter.transport
  });
  const provideTerminalPreview = (item: WorkbenchHostDockPopupItemInput) => {
    const snapshot = previewStore.get(item.node.id);
    if (!snapshot) {
      return null;
    }
    const externalState =
      (item.externalNodeState as TerminalNodeExternalState | null) ?? null;
    const theme = feature.resolveTheme({
      runtimeKind: externalState?.runtimeKind ?? "local",
      sessionId: externalState?.sessionId ?? null,
      status: externalState?.status ?? "created"
    });
    return {
      element: createElement(TerminalDockPreview, {
        frame: item.node.frame,
        snapshot,
        theme,
        viewport: item.previewViewport ?? null
      }),
      kind: "component" as const,
      revision: snapshot.revision
    };
  };

  const contribution = createTerminalWorkbenchContribution({
    contributionId: "workspace-terminal",
    dockEntry: {
      dockIcon: input.dockIcon,
      id: defaultWorkspaceTerminalWorkbenchTypeId,
      order: 40,
      sectionId: "apps"
    },
    externalStateSource: createWorkspaceTerminalNodeExternalStateSource({
      adapter: terminalAdapter,
      previewStore
    }),
    feature,
    getTerminalState: (sessionId) =>
      terminalAdapter.externalStateSource.get(sessionId),
    onCloseFailure: ({ error, sessionId }) =>
      logDesktopTerminalEvent({
        details: {
          error: error instanceof Error ? error.message : String(error),
          protocolCode: getTuttidProtocolErrorCode(error)
        },
        event: "close.request.error",
        level: "warn",
        runtimeApi: input.runtimeApi,
        sessionId,
        workspaceId: input.workspaceId
      }),
    onConfirmClose: (guard) =>
      input.confirmCloseGuard(
        createTerminalCloseDialogRequest({
          guard,
          i18n: input.i18n
        })
      ),
    resolveLaunchInput: (request) =>
      readTerminalWorkbenchIntent(request.payload),
    node: {
      onPreviewChange: (change) => previewStore.update(change),
      provideMinimizedPreview: provideTerminalPreview
    },
    shouldCloseAfterCloseFailure: ({ error, status }) =>
      shouldCloseTerminalNodeAfterCloseFailure({
        error,
        status
      }),
    typeId: defaultWorkspaceTerminalWorkbenchTypeId
  });

  return {
    ...contribution,
    dockEntries: contribution.dockEntries?.map((entry) =>
      entry.id === defaultWorkspaceTerminalWorkbenchTypeId
        ? {
            ...entry,
            providePopupItemPreview: provideTerminalPreview
          }
        : entry
    ),
    nodes: contribution.nodes?.map((node) =>
      node.typeId === defaultWorkspaceTerminalWorkbenchTypeId
        ? {
            ...node,
            renderHeader: node.renderHeader
              ? (context) =>
                  node.renderHeader?.({
                    ...context,
                    defaultActions: input.renderTrafficLights(context)
                  })
              : node.renderHeader,
            renderBody: (context) => {
              terminalAnalytics.observeNode({
                nodeId: context.node.id,
                openedParams: resolveTerminalOpenedParams(context)
              });
              return node.renderBody(context);
            }
          }
        : node
    ),
    prepareHostClose: ({ host }) =>
      closeWindowTerminalNodes({
        getTerminalState: (sessionId) =>
          terminalAdapter.externalStateSource.get(sessionId),
        host,
        logFailure: ({ error, sessionId }) =>
          logDesktopTerminalEvent({
            details: {
              error: error instanceof Error ? error.message : String(error),
              protocolCode: getTuttidProtocolErrorCode(error)
            },
            event: "window.close.terminal.error",
            level: "warn",
            runtimeApi: input.runtimeApi,
            sessionId,
            workspaceId: input.workspaceId
          }),
        terminalFeature: feature,
        terminalTypeId: defaultWorkspaceTerminalWorkbenchTypeId
      })
  };
}

function readTerminalWorkbenchIntent(
  payload: unknown
): TerminalWorkbenchIntent {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const typed = payload as Partial<TerminalWorkbenchIntent>;
  return {
    cwd: typeof typed.cwd === "string" ? typed.cwd : undefined,
    initialInput:
      typeof typed.initialInput === "string" ? typed.initialInput : undefined,
    profileId: typeof typed.profileId === "string" ? typed.profileId : undefined
  };
}

function createWorkspaceTerminalNodeExternalStateSource(input: {
  adapter: ReturnType<typeof createDesktopWorkspaceTerminalAdapter>;
  previewStore: WorkspaceTerminalPreviewStore;
}): WorkbenchHostExternalStateSource<TerminalNodeExternalState | null, null> {
  return {
    getNodeState(request) {
      if (request.typeId !== defaultWorkspaceTerminalWorkbenchTypeId) {
        return null;
      }
      return input.adapter.externalStateSource.get(
        request.instanceKey ?? request.instanceId
      );
    },
    getWorkspaceState() {
      return null;
    },
    subscribe(listener) {
      const unsubscribeAdapter =
        input.adapter.externalStateSource.subscribe(listener);
      const unsubscribePreview = input.previewStore.subscribe(listener);
      return () => {
        unsubscribeAdapter();
        unsubscribePreview();
      };
    }
  };
}

interface WorkspaceTerminalPreviewStore {
  get(nodeId: string): TerminalPreviewSnapshot | null;
  subscribe(listener: () => void): () => void;
  update(change: TerminalPreviewChange): void;
}

function createWorkspaceTerminalPreviewStore(): WorkspaceTerminalPreviewStore {
  const previewsByNodeId = new Map<string, TerminalPreviewSnapshot>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    get(nodeId) {
      return previewsByNodeId.get(nodeId) ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(change) {
      const current = previewsByNodeId.get(change.nodeId) ?? null;
      if (!change.snapshot) {
        if (!current) {
          return;
        }
        previewsByNodeId.delete(change.nodeId);
        notify();
        return;
      }
      if (current?.revision === change.snapshot.revision) {
        return;
      }
      previewsByNodeId.set(change.nodeId, change.snapshot);
      notify();
    }
  };
}
