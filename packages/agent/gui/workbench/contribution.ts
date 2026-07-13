import { createElement, type ReactNode } from "react";
import {
  type WorkbenchContribution,
  type WorkbenchFrame,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import {
  clampAgentGUIConversationRailWidthPx,
  resolveAgentGUIExpandedWindowFrame,
  shouldAutoCollapseAgentGUIConversationRail
} from "../agent-gui/agentGuiNode/model/agentGuiRailLayout.ts";
import { resolveAgentGuiSessionProviderIconUrl } from "../agentGuiSessionProviderIconUrls.ts";
import { setAgentGuiWorkbenchBodyRenderError } from "./bodyRenderErrorRegistry.ts";
import { AgentGuiWorkbenchHeader } from "./header.ts";
import {
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchTypeId,
  createAgentGuiWorkbenchLaunchDescriptor
} from "./launch.ts";
import {
  agentGuiWorkbenchProviderFromInstanceId,
  agentGuiWorkbenchProviderFromInstanceIdOrNull,
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

export const AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT =
  "tutti:agent-gui-workbench-conversation-rail-toggle";

export const AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT =
  "tutti:agent-gui-workbench-new-conversation";

/**
 * Fired when the empty-hero "Import session" suggestion is chosen. The host
 * chrome (which owns the external-agent import wizard state) listens for this
 * and opens the wizard.
 */
export const AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT =
  "tutti:agent-gui-workbench-open-external-import";

export interface AgentGuiWorkbenchConversationRailToggleDetail {
  conversationRailCollapsed: boolean;
  instanceId: string;
}

export interface AgentGuiWorkbenchNewConversationDetail {
  instanceId: string;
}

export interface AgentGuiWorkbenchConversationIdentity {
  iconUrl?: string | null;
  title: string | null;
}

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
}

export type AgentGuiWorkbenchContributionCopyOverrides =
  Partial<AgentGuiWorkbenchContributionCopy>;

export interface AgentGuiWorkbenchRenderBodyHelpers {
  agentDirectory: AgentGUIAgentDirectoryPort;
  nodeTypeId: string;
  onStateChange(state: AgentGuiWorkbenchState): void;
  provider: AgentGuiWorkbenchProvider;
}

export interface CreateAgentGuiWorkbenchContributionInput {
  agentDirectory: AgentGUIAgentDirectoryPort;
  copy?: AgentGuiWorkbenchContributionCopyOverrides;
  defaultProvider?: AgentGuiWorkbenchProvider | null;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  dockSectionId?: string;
  frame?: WorkbenchFrame;
  id?: string;
  providerAvailability?: AgentGuiWorkbenchProviderAvailability;
  renderBody(
    context: WorkbenchHostNodeBodyContext<
      AgentGuiWorkbenchState | null,
      unknown
    >,
    helpers: AgentGuiWorkbenchRenderBodyHelpers
  ): ReactNode;
  renderPreview?(
    context: WorkbenchHostNodeBodyContext<
      AgentGuiWorkbenchState | null,
      unknown
    >,
    helpers: AgentGuiWorkbenchRenderBodyHelpers
  ): ReactNode;
  renderMinimizedPreview(
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
  const frame = input.frame ?? agentGuiWorkbenchDefaultNodeFrame;
  const copy = resolveAgentGuiWorkbenchContributionCopy(input.copy);
  return {
    dockEntries: buildAgentGuiDockEntries({
      agentDirectory: input.agentDirectory,
      defaultProvider: input.defaultProvider,
      dockIconUrls: input.dockIconUrls,
      label: copy.nodeTitle,
      providerAvailability: input.providerAvailability,
      renderPreview: input.renderPreview,
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
        instance: { mode: "multi" },
        onBodyRenderErrorChange: ({ hasError, node }) => {
          setAgentGuiWorkbenchBodyRenderError(node.id, hasError);
        },
        renderBody: (context) =>
          input.renderBody(
            context as WorkbenchHostNodeBodyContext<
              AgentGuiWorkbenchState | null,
              unknown
            >,
            {
              agentDirectory: input.agentDirectory,
              nodeTypeId: agentGuiWorkbenchTypeId,
              onStateChange: (state) => {
                nodeStateSource.writeNodeState({
                  instanceId: context.instanceId,
                  nodeId: context.node.id,
                  state,
                  typeId: agentGuiWorkbenchTypeId
                });
              },
              provider:
                providerFromActivation(context.activation) ??
                agentGuiWorkbenchProviderFromInstanceId(context.instanceId)
            }
          ),
        renderHeader: ({
          activation,
          dragHandleProps,
          displayMode,
          externalNodeState,
          instanceId,
          isFocused,
          node,
          surfaceSize,
          windowActions
        }) => {
          const provider =
            providerFromActivation(activation) ??
            agentGuiWorkbenchProviderFromInstanceId(instanceId);
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
          const nodeState = normalizeAgentGuiWorkbenchNodeState(
            migratedWorkbenchState,
            provider
          );
          const isConversationRailAutoCollapsed =
            shouldAutoCollapseAgentGUIConversationRail(node.frame.width);
          const isConversationRailCollapsed =
            nodeState.conversationRailCollapsed === true ||
            isConversationRailAutoCollapsed;
          const conversationRailWidthPx = clampAgentGUIConversationRailWidthPx(
            nodeState.conversationRailWidthPx,
            node.frame.width
          );
          const conversationIdentity =
            input.resolveDockPopupIdentity?.(workbenchState) ?? null;
          const conversationTitle =
            conversationIdentity?.title ??
            input.resolveDockPopupTitle?.(workbenchState) ??
            null;
          // Resolve the icon from a *known* provider only. During a freshly
          // created session the provider is not encoded yet; falling back to
          // `provider` (which defaults to "codex") would flash the wrong icon,
          // so we leave the URL empty and let the header render a neutral
          // placeholder until the real provider resolves.
          const iconProvider =
            providerFromActivation(activation) ??
            agentGuiWorkbenchProviderFromInstanceIdOrNull(instanceId);
          const conversationIconFallbackUrl = iconProvider
            ? (resolveAgentGuiSessionProviderIconUrl(iconProvider) ??
              resolveAgentGuiWorkbenchProviderIconUrl({
                dockIconUrls: input.dockIconUrls,
                provider: iconProvider
              }))
            : null;
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
          const announceConversationRailCollapsed = (collapsed: boolean) => {
            window.dispatchEvent(
              new CustomEvent<AgentGuiWorkbenchConversationRailToggleDetail>(
                AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
                {
                  detail: {
                    conversationRailCollapsed: collapsed,
                    instanceId
                  }
                }
              )
            );
          };
          const announceNewConversation = () => {
            window.dispatchEvent(
              new CustomEvent<AgentGuiWorkbenchNewConversationDetail>(
                AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
                {
                  detail: {
                    instanceId
                  }
                }
              )
            );
          };

          return createElement(AgentGuiWorkbenchHeader, {
            copy,
            conversationIconUrl,
            conversationIconFallbackUrl,
            conversationTitle,
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
            onOpenDetachedWindow: input.onOpenDetachedWindow
              ? () => {
                  void input.onOpenDetachedWindow?.({
                    agentSessionId: workbenchState.lastActiveAgentSessionId,
                    agentTargetId: nodeState.agentTargetId,
                    provider,
                    workspaceId: input.workspaceId
                  });
                }
              : undefined,
            onPointerDown: (event) => {
              dragHandleProps.onPointerDown?.(event);
              if (!isFocused) {
                windowActions.focus();
              }
            },
            onToggleConversationRail: (nextCollapsed) => {
              announceConversationRailCollapsed(nextCollapsed);
              if (
                isConversationRailCollapsed &&
                nextCollapsed === false &&
                node.displayMode !== "fullscreen"
              ) {
                const expandedFrame = resolveAgentGUIExpandedWindowFrame({
                  conversationRailWidthPx: nodeState.conversationRailWidthPx,
                  desktopSize: surfaceSize,
                  height: node.frame.height,
                  position: {
                    x: node.frame.x,
                    y: node.frame.y
                  },
                  width: node.frame.width
                });

                windowActions.resize({
                  ...node.frame,
                  height: expandedFrame.size.height,
                  width: expandedFrame.size.width,
                  x: expandedFrame.position.x,
                  y: expandedFrame.position.y
                });
              }

              persistConversationRailCollapsed(nextCollapsed);
            }
          });
        },
        title: copy.nodeTitle,
        typeId: agentGuiWorkbenchTypeId,
        window: {
          closable: true,
          defaultOpen: false,
          minimizedDock: {
            kind: "component",
            providePreview: (item) =>
              createAgentGuiWorkbenchPreviewContent({
                agentDirectory: input.agentDirectory,
                item,
                renderPreview: input.renderMinimizedPreview,
                resolveDockPopupTitle: input.resolveDockPopupTitle
              })
          },
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
      if (
        !providerFromState(launchPayload) &&
        !agentGuiWorkbenchProviderFromIdentifier(request.dockEntryId)
      ) {
        return null;
      }
      const {
        activation,
        dockEntryId,
        instanceId: descriptorInstanceId,
        openInNewWindow,
        provider,
        reuseDockEntryNode,
        reuseExistingSessionNode,
        targetAgentSessionId
      } = createAgentGuiWorkbenchLaunchDescriptor({
        ...request,
        payload: launchPayload
      });
      // Locate an already-open node currently showing this session (its launch
      // instanceId may differ from the session-keyed one, e.g. a conversation
      // started fresh as a draft) so we focus it instead of opening a duplicate.
      const existingInstanceId =
        targetAgentSessionId && reuseExistingSessionNode
          ? nodeStateSource.findInstanceIdByAgentSessionId(targetAgentSessionId)
          : null;
      const instanceId = existingInstanceId ?? descriptorInstanceId;
      const title = copy.nodeTitle;
      const providerTarget = providerTargetLaunchPayloadFromRequest(
        launchPayload,
        provider
      );
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
        reuseDockEntryNode,
        title,
        typeId: agentGuiWorkbenchTypeId
      };
    }
  };
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
  createAgentGuiWorkbenchPreviewContent,
  isAgentGuiWorkbenchCompactVisibleFrame,
  providerFromActivation,
  providerFromState,
  providerTargetLaunchPayloadFromRequest,
  resolveAgentGuiWorkbenchLaunchPayload,
  resolveAgentGuiWorkbenchProviderIconUrl,
  resolveAgentGuiWorkbenchContributionCopy,
  resolveAgentGuiWorkbenchDefaultLaunchFrame
} from "./contributionDock.tsx";
import type { AgentGuiWorkbenchProviderAvailability } from "./contributionDock.tsx";
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
  BuildAgentGuiDockEntriesInput
} from "./contributionDock.tsx";
