import { createElement, type ReactNode } from "react";
import {
  selectWorkspaceAgentConsumerSession,
  type AgentSessionEngine
} from "@tutti-os/agent-activity-core";
import {
  type WorkbenchContribution,
  type WorkbenchFrame,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import {
  resolveAgentGUIConversationRailPresentation,
  resolveAgentGUIExpandedWindowFrame
} from "../agent-gui/agentGuiNode/model/agentGuiRailLayout.ts";
import type { AgentGUIConversationRailLayout } from "../agent-gui/agentGuiNode/view/AgentGUINodeView.types.ts";
import { setAgentGuiWorkbenchBodyRenderError } from "./bodyRenderErrorRegistry.ts";
import { AgentGuiWorkbenchRailAlignedHeader } from "./AgentGuiWorkbenchRailAlignedHeader.tsx";
import { createAgentGuiWorkbenchRailLayoutStore } from "./agentGuiWorkbenchRailLayout.ts";
import type { AgentGuiWorkbenchHeaderProps } from "./header.ts";
import type { AgentGuiWorkbenchConversationIdentity } from "./conversationIdentity.ts";
import {
  agentGuiWorkbenchTypeId,
  createAgentGuiWorkbenchLaunchDescriptor
} from "./launch.ts";
import {
  createAgentGuiWorkbenchNodeStateSource,
  migrateLegacyAgentGuiWorkbenchState,
  normalizeAgentGuiWorkbenchNodeState,
  normalizeAgentGuiWorkbenchState
} from "./state.ts";
import type {
  AgentGuiWorkbenchNodeState,
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";
import type { AgentGUIAgentDirectoryPort } from "../types.ts";
import {
  dispatchAgentGuiWorkbenchCommand,
  isAgentGuiWorkbenchSessionAction
} from "./commands.ts";
import type {
  AgentGuiWorkbenchSessionAction,
  AgentGuiWorkbenchSessionMenuCopy
} from "./commands.ts";

/**
 * Fired when the empty-hero "Import session" suggestion is chosen. The host
 * chrome (which owns the external-agent import wizard state) listens for this
 * and opens the wizard.
 */
export const AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT =
  "tutti:agent-gui-workbench-open-external-import";

export { dispatchAgentGuiWorkbenchCommand, isAgentGuiWorkbenchSessionAction };
export type {
  AgentGuiWorkbenchSessionAction,
  AgentGuiWorkbenchSessionMenuCopy
};

export type { AgentGuiWorkbenchConversationIdentity } from "./conversationIdentity.ts";

export interface AgentGuiWorkbenchContributionCopy {
  collapseConversationRail: string;
  close: string;
  expandConversationRail: string;
  fallbackAgentLabel: string;
  maximize: string;
  minimize: string;
  newConversation: string;
  nodeTitle: string;
  openDetachedWindow: string;
  restore: string;
  untitledConversation: string;
  sessionMenu?: AgentGuiWorkbenchSessionMenuCopy | null;
}

export type AgentGuiWorkbenchContributionCopyOverrides =
  Partial<AgentGuiWorkbenchContributionCopy>;

export interface AgentGuiWorkbenchRenderBodyHelpers {
  agentDirectory: AgentGUIAgentDirectoryPort;
  agentTargetId: string | null;
  nodeTypeId: string;
  onConversationRailLayoutChange(layout: AgentGUIConversationRailLayout): void;
  onStateChange(state: AgentGuiWorkbenchState): void;
  provider: AgentGuiWorkbenchProvider | null;
}

export interface CreateAgentGuiWorkbenchContributionInput {
  agentDirectory: AgentGUIAgentDirectoryPort;
  copy?: AgentGuiWorkbenchContributionCopyOverrides;
  defaultProvider?: AgentGuiWorkbenchProvider | null;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  dockSectionId?: string;
  frame?: WorkbenchFrame;
  id?: string;
  providerAvailability?: AgentGuiWorkbenchProviderAvailabilitySource;
  renderBody(
    context: WorkbenchHostNodeBodyContext<
      AgentGuiWorkbenchState | null,
      unknown
    >,
    helpers: AgentGuiWorkbenchRenderBodyHelpers
  ): ReactNode;
  resolveDockPopupTitle?: (
    state: AgentGuiWorkbenchState | null
  ) => string | null;
  resolveDockPopupIdentity?: (
    state: AgentGuiWorkbenchState | null
  ) => AgentGuiWorkbenchConversationIdentity | null;
  sessionEngine?: AgentSessionEngine;
  onOpenDetachedWindow?: (input: {
    agentSessionId?: string | null;
    agentTargetId?: string | null;
    provider: AgentGuiWorkbenchProvider;
    workspaceId: string;
  }) => void | Promise<void>;
  unifiedDockIconUrl?: string;
  workspaceId: string;
}

export function createAgentGuiWorkbenchContribution(
  input: CreateAgentGuiWorkbenchContributionInput
): WorkbenchContribution {
  const nodeStateSource = createAgentGuiWorkbenchNodeStateSource({
    workspaceId: input.workspaceId
  });
  const railLayoutStore = createAgentGuiWorkbenchRailLayoutStore();
  const frame = input.frame ?? agentGuiWorkbenchDefaultNodeFrame;
  const copy = resolveAgentGuiWorkbenchContributionCopy(input.copy);
  return {
    dockEntries: buildAgentGuiDockEntries({
      agentDirectory: input.agentDirectory,
      defaultProvider: input.defaultProvider,
      dockIconUrls: input.dockIconUrls,
      label: copy.nodeTitle,
      providerAvailability: input.providerAvailability,
      resolveDockPopupIdentity: input.resolveDockPopupIdentity,
      resolveDockPopupTitle: input.resolveDockPopupTitle,
      sectionId: input.dockSectionId ?? "agents",
      unifiedDockIconUrl: input.unifiedDockIconUrl
    }),
    externalStateSource: nodeStateSource.externalStateSource,
    id: input.id ?? "workspace-agent-gui",
    nodes: [
      {
        frame,
        getWindowCloseEffect: ({ externalNodeState, node }) => {
          if (!input.sessionEngine) {
            return null;
          }
          const workbenchState = normalizeAgentGuiWorkbenchState(
            migrateLegacyAgentGuiWorkbenchState(externalNodeState)
          );
          const consumerSession = selectWorkspaceAgentConsumerSession(
            input.sessionEngine.getSnapshot(),
            workbenchState.lastActiveAgentSessionId
          );
          if (
            consumerSession?.displayStatus !== "working" &&
            consumerSession?.displayStatus !== "waiting"
          ) {
            return null;
          }
          return {
            nodeId: node.id,
            title: node.title,
            typeId: agentGuiWorkbenchTypeId
          };
        },
        getHeaderFrameRenderKey: (context) => {
          if (context.isDragging) {
            return "dragging";
          }
          const rawWorkbenchState = (context.externalNodeState ??
            context.node.data.runtimeNodeState) as
            | Partial<AgentGuiWorkbenchNodeState>
            | null
            | undefined;
          const workbenchState = normalizeAgentGuiWorkbenchState(
            migrateLegacyAgentGuiWorkbenchState(rawWorkbenchState)
          );
          const railPresentation = resolveAgentGUIConversationRailPresentation({
            containerWidthPx: context.node.frame.width,
            conversationRailCollapsed: workbenchState.conversationRailCollapsed,
            conversationRailWidthPx: workbenchState.conversationRailWidthPx
          });
          if (railPresentation.isCollapsed) {
            return "collapsed";
          }
          return `expanded:${railPresentation.conversationRailWidthPx}`;
        },
        instance: { mode: "multi" },
        onBodyRenderErrorChange: ({ hasError, node }) => {
          setAgentGuiWorkbenchBodyRenderError(node.id, hasError);
        },
        renderBody: (context) => {
          const persistedState = normalizeAgentGuiWorkbenchState(
            context.externalNodeState ?? context.node?.data.snapshotNodeState
          );
          const activationAgentTargetId = agentTargetIdFromActivation(
            context.activation
          );
          const state =
            activationAgentTargetId && !persistedState.agentTargetId
              ? { ...persistedState, agentTargetId: activationAgentTargetId }
              : persistedState;
          const agent = resolveAgentGuiWorkbenchStateAgent(
            state,
            input.agentDirectory
          );
          return input.renderBody(
            context as WorkbenchHostNodeBodyContext<
              AgentGuiWorkbenchState | null,
              unknown
            >,
            {
              agentDirectory: input.agentDirectory,
              agentTargetId: state.agentTargetId ?? null,
              nodeTypeId: agentGuiWorkbenchTypeId,
              onConversationRailLayoutChange: (layout) => {
                railLayoutStore.report(context.node.id, layout);
              },
              onStateChange: (nextState) => {
                nodeStateSource.writeNodeState({
                  instanceId: context.instanceId,
                  nodeId: context.node.id,
                  state: nextState,
                  typeId: agentGuiWorkbenchTypeId
                });
              },
              provider: agent?.provider ?? null
            }
          );
        },
        renderHeader: ({
          dragHandleProps,
          displayMode,
          externalNodeState,
          instanceId,
          isFocused,
          node,
          surfaceSize,
          windowActions
        }) => {
          const headerTitle = copy.nodeTitle;
          const rawWorkbenchState = (externalNodeState ??
            node.data.runtimeNodeState) as
            | Partial<AgentGuiWorkbenchNodeState>
            | null
            | undefined;
          const migratedWorkbenchState =
            migrateLegacyAgentGuiWorkbenchState(rawWorkbenchState);
          const workbenchState = normalizeAgentGuiWorkbenchState(
            migratedWorkbenchState
          );
          const selectedAgent = resolveAgentGuiWorkbenchStateAgent(
            workbenchState,
            input.agentDirectory
          );
          const provider = selectedAgent?.provider ?? "unknown";
          const nodeState = normalizeAgentGuiWorkbenchNodeState(
            migratedWorkbenchState,
            provider
          );
          const railPresentation = resolveAgentGUIConversationRailPresentation({
            containerWidthPx: node.frame.width,
            conversationRailCollapsed: nodeState.conversationRailCollapsed,
            conversationRailWidthPx: nodeState.conversationRailWidthPx
          });
          const isConversationRailAutoCollapsed =
            railPresentation.isAutoCollapsed;
          const isConversationRailCollapsed = railPresentation.isCollapsed;
          const conversationRailWidthPx =
            railPresentation.conversationRailWidthPx;
          const conversationIdentity = input.sessionEngine
            ? null
            : (input.resolveDockPopupIdentity?.(workbenchState) ?? null);
          const conversationTitle = input.sessionEngine
            ? null
            : (conversationIdentity?.title ??
              input.resolveDockPopupTitle?.(workbenchState) ??
              null);
          const hasConversation = Boolean(
            workbenchState.lastActiveAgentSessionId?.trim()
          );
          const conversationIconFallbackUrl = selectedAgent?.iconUrl ?? null;
          const conversationIconUrl =
            conversationIdentity?.iconUrl ?? conversationIconFallbackUrl;
          const persistConversationRailCollapsed = (collapsed: boolean) => {
            nodeStateSource.writeNodeState({
              instanceId,
              nodeId: node.id,
              state: {
                ...workbenchState,
                conversationRailCollapsed: collapsed
              },
              typeId: agentGuiWorkbenchTypeId
            });
          };
          const announceNewConversation = () => {
            dispatchAgentGuiWorkbenchCommand({
              instanceId,
              type: "new-conversation"
            });
          };
          const announceSessionAction = (
            action: AgentGuiWorkbenchSessionAction
          ) => {
            dispatchAgentGuiWorkbenchCommand({
              action,
              agentSessionId: workbenchState.lastActiveAgentSessionId,
              instanceId,
              type: "session-action"
            });
          };

          const headerProps = {
            copy,
            conversationIconFallbackUrl,
            conversationRailWidthPx,
            displayMode,
            isConversationRailAutoCollapsed,
            isConversationRailCollapsed,
            nodeId: node.id,
            providerRailWidthPx: agentGuiWorkbenchProviderRailWidthPx,
            title: headerTitle,
            windowActions: {
              close: windowActions.close,
              minimize: windowActions.minimize,
              toggleDisplayMode: windowActions.toggleDisplayMode
            },
            ...dragHandleProps,
            onCreateConversation: announceNewConversation,
            onSessionAction: announceSessionAction,
            onOpenDetachedWindow: input.onOpenDetachedWindow
              ? selectedAgent
                ? () => {
                    void input.onOpenDetachedWindow?.({
                      agentSessionId: workbenchState.lastActiveAgentSessionId,
                      agentTargetId: selectedAgent.agentTargetId,
                      provider: selectedAgent.provider,
                      workspaceId: input.workspaceId
                    });
                  }
                : undefined
              : undefined,
            onPointerDown: (event) => {
              dragHandleProps.onPointerDown?.(event);
              if (!isFocused) {
                windowActions.focus();
              }
            },
            onToggleConversationRail: (nextCollapsed) => {
              dispatchAgentGuiWorkbenchCommand({
                conversationRailCollapsed: nextCollapsed,
                instanceId,
                type: "conversation-rail-toggle"
              });
              if (
                isConversationRailCollapsed &&
                nextCollapsed === false &&
                node.displayMode !== "fullscreen"
              ) {
                const currentFrame = windowActions.getFrame();
                const expandedFrame = resolveAgentGUIExpandedWindowFrame({
                  conversationRailWidthPx: nodeState.conversationRailWidthPx,
                  desktopSize: surfaceSize,
                  height: currentFrame.height,
                  position: {
                    x: currentFrame.x,
                    y: currentFrame.y
                  },
                  width: currentFrame.width
                });

                windowActions.resize({
                  ...currentFrame,
                  height: expandedFrame.size.height,
                  width: expandedFrame.size.width,
                  x: expandedFrame.position.x,
                  y: expandedFrame.position.y
                });
              }

              persistConversationRailCollapsed(nextCollapsed);
            }
          } satisfies AgentGuiWorkbenchHeaderProps;
          return createElement(AgentGuiWorkbenchRailAlignedHeader, {
            ...headerProps,
            agentDirectory: input.agentDirectory,
            agentTitle: conversationIdentity?.agentTitle,
            conversationIconUrl,
            conversationTitle,
            dockIconUrls: input.dockIconUrls,
            hasConversation,
            railLayoutStore,
            sessionEngine: input.sessionEngine,
            workbenchState
          });
        },
        title: copy.nodeTitle,
        typeId: agentGuiWorkbenchTypeId,
        window: {
          closable: true,
          defaultOpen: false,
          header: {
            border: "none",
            layout: "overlay"
          },
          minimizedDock: { kind: "snapshot" },
          minimizable: true
        }
      }
    ],
    onLaunchRequest: (request) => {
      if (request.typeId !== agentGuiWorkbenchTypeId) {
        return null;
      }

      const launchPayload = resolveAgentGuiWorkbenchLaunchPayload(request, {
        agentDirectory: input.agentDirectory,
        defaultProvider: input.defaultProvider,
        providerAvailability: input.providerAvailability
      });
      if (
        !hasAgentSessionId(launchPayload) &&
        !providerTargetLaunchPayloadFromRequest(
          launchPayload,
          providerFromState(launchPayload) ?? "codex"
        ).agentTargetId
      ) {
        return null;
      }
      if (!providerFromState(launchPayload)) {
        return null;
      }
      const {
        activation,
        dockEntryId,
        instanceId: descriptorInstanceId,
        openInNewWindow,
        provider,
        reusePolicy,
        targetAgentSessionId
      } = createAgentGuiWorkbenchLaunchDescriptor({
        ...request,
        payload: launchPayload
      });
      const providerTarget = providerTargetLaunchPayloadFromRequest(
        launchPayload,
        provider
      );
      // Locate an already-open node currently showing this session (its launch
      // instanceId may differ from the session-keyed one, e.g. a conversation
      // started fresh as a draft) so we focus it instead of opening a duplicate.
      const existingInstanceId =
        reusePolicy.kind === "current-session"
          ? nodeStateSource.findInstanceIdByAgentSessionId(
              reusePolicy.agentSessionId
            )
          : null;
      const instanceId = existingInstanceId ?? descriptorInstanceId;
      const title = copy.nodeTitle;
      const launchAgentTargetId = providerTarget.agentTargetId;
      if (targetAgentSessionId) {
        const previousState = nodeStateSource.readNodeState({
          instanceId,
          typeId: agentGuiWorkbenchTypeId
        });
        nodeStateSource.writeNodeState({
          instanceId,
          state: {
            ...normalizeAgentGuiWorkbenchState(previousState),
            ...(targetAgentSessionId
              ? { lastActiveAgentSessionId: targetAgentSessionId }
              : {}),
            agentTargetId: launchAgentTargetId ?? null
          },
          typeId: agentGuiWorkbenchTypeId
        });
      } else if (providerTarget.agentTargetId) {
        const previousState = nodeStateSource.readNodeState({
          instanceId,
          typeId: agentGuiWorkbenchTypeId
        });
        nodeStateSource.writeNodeState({
          instanceId,
          state: {
            ...normalizeAgentGuiWorkbenchState(previousState),
            lastActiveAgentSessionId: null,
            agentTargetId: providerTarget.agentTargetId
          },
          typeId: agentGuiWorkbenchTypeId
        });
      }
      const defaultFrame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
        frame,
        request
      });
      return {
        activation,
        ...(openInNewWindow
          ? { cascadeOffset: agentGuiWorkbenchNewWindowCascadeOffset }
          : {}),
        defaultFrame,
        dockEntryId,
        framePolicy:
          !openInNewWindow &&
          isAgentGuiWorkbenchCompactVisibleFrame(defaultFrame, frame)
            ? "absolute"
            : "cascade-same-type-centered",
        instanceId,
        // Reusing the window already showing this specific conversation
        // (e.g. clicking a completion notification) should just focus it,
        // not reset it back to the default size/position.
        preserveExistingNodeFrame: existingInstanceId !== null,
        reuseDockEntryNode: reusePolicy.kind === "dock-entry",
        title,
        typeId: agentGuiWorkbenchTypeId
      };
    }
  };
}

function resolveAgentGuiWorkbenchStateAgent(
  state: AgentGuiWorkbenchState | null,
  directory: AgentGUIAgentDirectoryPort
) {
  const agentTargetId = state?.agentTargetId?.trim();
  if (!agentTargetId) {
    return null;
  }
  return (
    directory
      .getSnapshot()
      .agents.find((agent) => agent.agentTargetId === agentTargetId) ?? null
  );
}

function agentTargetIdFromActivation(activation: unknown): string | null {
  if (!activation || typeof activation !== "object") {
    return null;
  }
  const payload = (activation as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const agentTargetId = (payload as { agentTargetId?: unknown }).agentTargetId;
  return typeof agentTargetId === "string" && agentTargetId.trim()
    ? agentTargetId.trim()
    : null;
}

function hasAgentSessionId(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return (
    typeof (payload as { agentSessionId?: unknown }).agentSessionId ===
      "string" &&
    (payload as { agentSessionId: string }).agentSessionId.trim().length > 0
  );
}

import {
  agentGuiWorkbenchDefaultNodeFrame,
  agentGuiWorkbenchNewWindowCascadeOffset,
  agentGuiWorkbenchProviderRailWidthPx,
  buildAgentGuiDockEntries,
  isAgentGuiWorkbenchCompactVisibleFrame,
  providerFromState,
  providerTargetLaunchPayloadFromRequest,
  resolveAgentGuiWorkbenchLaunchPayload,
  resolveAgentGuiWorkbenchContributionCopy,
  resolveAgentGuiWorkbenchDefaultLaunchFrame
} from "./contributionDock.tsx";
import type { AgentGuiWorkbenchProviderAvailabilitySource } from "./contributionDock.tsx";
export {
  agentGuiWorkbenchCompactVisibleAreaRatio,
  agentGuiWorkbenchDefaultCopy,
  agentGuiWorkbenchDefaultNodeFrame,
  agentGuiWorkbenchDefaultUsableHeightRatio,
  agentGuiWorkbenchDefaultUsableWidthRatio,
  agentGuiWorkbenchNewWindowCascadeOffset,
  agentGuiWorkbenchProviderRailWidthPx,
  buildAgentGuiDockEntries,
  resolveAgentGuiUnifiedDockLaunchPayload,
  resolveAgentGuiWorkbenchContributionCopy,
  resolveAgentGuiWorkbenchDefaultLaunchFrame
} from "./contributionDock.tsx";
export type {
  AgentGuiWorkbenchProviderAvailability,
  AgentGuiWorkbenchProviderAvailabilitySource,
  BuildAgentGuiDockEntriesInput
} from "./contributionDock.tsx";
