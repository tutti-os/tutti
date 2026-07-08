import { createElement, type ReactNode } from "react";
import {
  getWorkbenchLayoutFrame,
  type WorkbenchContribution,
  type WorkbenchDockPreviewContent,
  type WorkbenchFrame,
  type WorkbenchHostDockEntry,
  type WorkbenchHostDockPopupItemInput,
  type WorkbenchHostLaunchRequest,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import {
  clampAgentGUIConversationRailWidthPx,
  resolveAgentGUIExpandedWindowFrame,
  shouldAutoCollapseAgentGUIConversationRail
} from "../agent-gui/agentGuiNode/model/agentGuiRailLayout.ts";
import { agentGuiDockIconUrls } from "../dockIcons.ts";
import { resolveAgentGuiSessionProviderIconUrl } from "../agentGuiSessionProviderIconUrls.ts";
import { setAgentGuiWorkbenchBodyRenderError } from "./bodyRenderErrorRegistry.ts";
import { AgentGuiWorkbenchHeader } from "./header.ts";
import {
  agentGuiWorkbenchDockIdentityFromIdentifier,
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchTypeId,
  agentGuiWorkbenchUnifiedDockEntryId,
  createAgentGuiWorkbenchLaunchDescriptor
} from "./launch.ts";
import {
  agentGuiWorkbenchProviderFromInstanceId,
  agentGuiWorkbenchProviderFromInstanceIdOrNull,
  createAgentGuiWorkbenchNodeStateSource,
  normalizeAgentGuiWorkbenchNodeState,
  normalizeAgentGuiWorkbenchState
} from "./state.ts";
import {
  agentGuiWorkbenchDefaultDockProviders,
  isAgentGuiWorkbenchProvider,
  resolveAgentGuiWorkbenchProviderLabel
} from "./providerCatalog.ts";
import type {
  AgentGuiWorkbenchNodeState,
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";
import { normalizeAgentGUIProviderTargets } from "../providerTargets.ts";
import type {
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
} from "../types.ts";

export const agentGuiWorkbenchDefaultNodeFrame: WorkbenchFrame = {
  height: 560,
  width: 1040,
  x: 140,
  y: 48
};

export const agentGuiWorkbenchDefaultUsableWidthRatio = 0.8;
export const agentGuiWorkbenchDefaultUsableHeightRatio = 0.9;
export const agentGuiWorkbenchCompactVisibleAreaRatio = 0.9;
export const agentGuiWorkbenchNewWindowCascadeOffset = { x: 180, y: 88 };
export const agentGuiWorkbenchProviderRailWidthPx = 52;
const agentGuiWorkbenchUnifiedDockTileProviders = [
  "codex",
  "claude-code",
  "tutti-agent",
  "hermes"
] as const satisfies readonly AgentGuiWorkbenchProvider[];

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

export const agentGuiWorkbenchDefaultCopy: AgentGuiWorkbenchContributionCopy = {
  collapseConversationRail: "Collapse conversation rail",
  close: "Close",
  expandConversationRail: "Expand conversation rail",
  fallbackAgentLabel: "Agent",
  maximize: "Maximize",
  minimize: "Minimize",
  newConversation: "New conversation",
  nodeTitle: "Agent",
  openDetachedWindow: "Open in detached window",
  restore: "Restore"
};

export interface AgentGuiWorkbenchRenderBodyHelpers {
  nodeTypeId: string;
  onStateChange(state: AgentGuiWorkbenchState): void;
  provider: AgentGuiWorkbenchProvider;
}

export interface CreateAgentGuiWorkbenchContributionInput {
  copy?: AgentGuiWorkbenchContributionCopyOverrides;
  defaultProvider?: AgentGuiWorkbenchProvider | null;
  defaultProviderTargetId?: string | null;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  dockSectionId?: string;
  frame?: WorkbenchFrame;
  id?: string;
  providerAvailability?: AgentGuiWorkbenchProviderAvailability;
  providerTargets?: readonly AgentGUIProviderTarget[] | null;
  providerTargetsLoading?: boolean;
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
  resolveDockLaunchPayload?: (input: {
    dockEntryId?: string | null;
    payload: unknown;
    reason: WorkbenchHostLaunchRequest["reason"];
  }) => unknown | null | undefined;
  onOpenDetachedWindow?: (input: {
    agentSessionId?: string | null;
    agentTargetId?: string | null;
    providerTargets?: readonly AgentGUIProviderTarget[];
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
      defaultProvider: input.defaultProvider,
      defaultProviderTargetId: input.defaultProviderTargetId,
      dockIconUrls: input.dockIconUrls,
      label: copy.nodeTitle,
      providerAvailability: input.providerAvailability,
      providerTargetsLoading: input.providerTargetsLoading,
      renderPreview: input.renderPreview,
      resolveDockPopupIdentity: input.resolveDockPopupIdentity,
      resolveDockPopupTitle: input.resolveDockPopupTitle,
      sectionId: input.dockSectionId ?? "agents",
      targets: input.providerTargets,
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
          const workbenchState =
            normalizeAgentGuiWorkbenchState(rawWorkbenchState);
          const nodeState = normalizeAgentGuiWorkbenchNodeState(
            rawWorkbenchState,
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
            workbenchState.lastActiveConversationTitle ??
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
                    providerTargets: input.providerTargets ?? undefined,
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
        resolveDockLaunchPayload: input.resolveDockLaunchPayload
      });
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
      const launchAgentTargetId =
        providerTarget.agentTargetId ?? providerTarget.providerTargetId;
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
      } else if (
        providerTarget.agentTargetId ||
        providerTarget.providerTargetId ||
        providerTarget.providerTargetRef
      ) {
        const previousState = nodeStateSource.readNodeState({
          instanceId,
          typeId: agentGuiWorkbenchTypeId
        });
        nodeStateSource.writeNodeState({
          instanceId,
          state: {
            ...normalizeAgentGuiWorkbenchState(previousState),
            ...(providerTarget.agentTargetId
              ? { agentTargetId: providerTarget.agentTargetId }
              : {}),
            ...(providerTarget.providerTargetId
              ? { agentTargetId: providerTarget.providerTargetId }
              : {})
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

export type AgentGuiWorkbenchProviderAvailability = Partial<
  Record<
    AgentGuiWorkbenchProvider,
    | boolean
    | "available"
    | "ready"
    | "unavailable"
    | {
        available?: boolean | null;
        status?: string | null;
      }
    | null
    | undefined
  >
>;

export interface BuildAgentGuiDockEntriesInput {
  defaultProvider?: AgentGuiWorkbenchProvider | null;
  defaultProviderTargetId?: string | null;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  label?: string;
  providerAvailability?: AgentGuiWorkbenchProviderAvailability;
  providerTargetsLoading?: boolean;
  renderPreview?: CreateAgentGuiWorkbenchContributionInput["renderPreview"];
  resolveDockPopupIdentity?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupIdentity"];
  resolveDockPopupTitle?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupTitle"];
  sectionId?: string;
  targets?: readonly AgentGUIProviderTarget[] | null;
  unifiedDockIconUrl?: string;
}

export function buildAgentGuiDockEntries(
  input: BuildAgentGuiDockEntriesInput
): WorkbenchHostDockEntry[] {
  const sectionId = input.sectionId ?? "agents";
  const launchPayload = resolveAgentGuiUnifiedDockLaunchPayload(input);
  const provider = launchPayload.provider;
  const unifiedTileIconUrls = resolveAgentGuiUnifiedDockTileIconUrls(
    input.dockIconUrls
  );
  return [
    createAgentGuiWorkbenchDockEntry({
      aggregateProviders: agentGuiWorkbenchDefaultDockProviders,
      icon: input.unifiedDockIconUrl
        ? createAgentGuiWorkbenchUnifiedDockIcon({
            iconUrl: input.unifiedDockIconUrl
          })
        : createAgentGuiWorkbenchLaunchpadStyleDockIcon({
            tileIconUrls: unifiedTileIconUrls
          }),
      label: input.label ?? agentGuiWorkbenchDefaultCopy.nodeTitle,
      launchPayload,
      order: 0,
      provider,
      renderPreview: input.renderPreview,
      resolveDockPopupIdentity: input.resolveDockPopupIdentity,
      resolveDockPopupTitle: input.resolveDockPopupTitle,
      sectionId,
      visibility: "always"
    })
  ];
}

export function resolveAgentGuiUnifiedDockLaunchPayload(
  input: Pick<
    BuildAgentGuiDockEntriesInput,
    | "defaultProvider"
    | "defaultProviderTargetId"
    | "providerAvailability"
    | "providerTargetsLoading"
    | "targets"
  >
): {
  provider: AgentGuiWorkbenchProvider;
  agentTargetId?: string;
  providerTargetId?: string;
  providerTargetRef?: AgentGUIProviderTargetRef;
} {
  const target = resolveUnifiedAgentGuiDockTarget(input);
  if (target) {
    return {
      provider: target.provider,
      ...(target.agentTargetId ? { agentTargetId: target.agentTargetId } : {}),
      providerTargetId: target.targetId,
      providerTargetRef: target.ref
    };
  }
  return {
    provider: resolveUnifiedAgentGuiDockProvider(input)
  };
}

export function resolveAgentGuiWorkbenchDefaultLaunchFrame(input: {
  frame: WorkbenchFrame;
  request: Pick<
    WorkbenchHostLaunchRequest,
    "layoutConstraints" | "surfaceSize"
  >;
}): WorkbenchFrame {
  const layoutFrame = getWorkbenchLayoutFrame(
    input.request.surfaceSize,
    input.request.layoutConstraints
  );
  const defaultHeight = Math.round(
    layoutFrame.height * agentGuiWorkbenchDefaultUsableHeightRatio
  );
  const defaultWidth = Math.round(
    layoutFrame.width * agentGuiWorkbenchDefaultUsableWidthRatio
  );

  return {
    ...input.frame,
    height: defaultHeight,
    width: defaultWidth,
    x: Math.round(layoutFrame.x + (layoutFrame.width - defaultWidth) / 2),
    y: Math.round(layoutFrame.y + (layoutFrame.height - defaultHeight) / 2)
  };
}

function isAgentGuiWorkbenchCompactVisibleFrame(
  frame: WorkbenchFrame,
  defaultFrame: WorkbenchFrame
): boolean {
  return frame.width !== defaultFrame.width || frame.x !== defaultFrame.x;
}

export function resolveAgentGuiWorkbenchContributionCopy(
  copy?: AgentGuiWorkbenchContributionCopyOverrides
): AgentGuiWorkbenchContributionCopy {
  return {
    ...agentGuiWorkbenchDefaultCopy,
    ...copy
  };
}

function createAgentGuiWorkbenchDockEntry(input: {
  aggregateProviders?: readonly AgentGuiWorkbenchProvider[];
  icon: ReactNode;
  label: string;
  launchPayload?: Record<string, unknown>;
  order: number;
  provider: AgentGuiWorkbenchProvider;
  renderPreview?: CreateAgentGuiWorkbenchContributionInput["renderPreview"];
  resolveDockPopupIdentity?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupIdentity"];
  resolveDockPopupTitle?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupTitle"];
  sectionId: string;
  visibility: WorkbenchHostDockEntry["visibility"];
}): WorkbenchHostDockEntry {
  return {
    icon: input.icon,
    iconSize: "large",
    id: agentGuiWorkbenchUnifiedDockEntryId(),
    label: input.label,
    launchBehavior: "enabled",
    launchPayload: input.launchPayload ?? { provider: input.provider },
    matchNode: (node) =>
      node.data.typeId === agentGuiWorkbenchTypeId &&
      (input.aggregateProviders
        ? input.aggregateProviders.includes(
            resolveAgentGuiWorkbenchProviderFromNode(node)
          )
        : resolveAgentGuiWorkbenchProviderFromNode(node) === input.provider),
    order: input.order,
    providePopupItemPreview: (item) =>
      input.renderPreview
        ? createAgentGuiWorkbenchPreviewContent({
            item,
            label: input.label,
            provider: input.provider,
            renderPreview: input.renderPreview,
            resolveDockPopupIdentity: input.resolveDockPopupIdentity,
            resolveDockPopupTitle: input.resolveDockPopupTitle
          })
        : null,
    resolvePopupItem: ({ externalNodeState }) => {
      const state = normalizeAgentGuiWorkbenchState(externalNodeState);
      const title =
        input.resolveDockPopupIdentity?.(state)?.title ??
        input.resolveDockPopupTitle?.(state) ??
        null;
      return {
        revision: `${input.provider}\n${title ?? ""}`,
        title
      };
    },
    sectionId: input.sectionId,
    typeId: agentGuiWorkbenchTypeId,
    visibility: input.visibility
  };
}

function resolveAgentGuiUnifiedDockTileIconUrls(
  dockIconUrls: Partial<Record<AgentGuiWorkbenchProvider, string>> | undefined
): readonly string[] {
  return agentGuiWorkbenchUnifiedDockTileProviders.map((provider) =>
    resolveAgentGuiWorkbenchProviderIconUrl({ dockIconUrls, provider })
  );
}

function resolveAgentGuiWorkbenchProviderIconUrl(input: {
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  provider: AgentGuiWorkbenchProvider;
}): string {
  return (
    input.dockIconUrls?.[input.provider] ?? agentGuiDockIconUrls[input.provider]
  );
}

function createAgentGuiWorkbenchLaunchpadStyleDockIcon(input: {
  tileIconUrls: readonly string[];
}): ReactNode {
  return createElement(
    "span",
    {
      "aria-hidden": "true",
      className: "agent-gui-workbench-dock-icon"
    },
    input.tileIconUrls.map((src, index) =>
      createElement(
        "span",
        {
          className: "agent-gui-workbench-dock-icon__tile",
          key: `${src}:${index}`
        },
        createElement("img", {
          alt: "",
          draggable: false,
          src
        })
      )
    )
  );
}

function createAgentGuiWorkbenchUnifiedDockIcon(input: {
  iconUrl: string;
}): ReactNode {
  return createElement(
    "span",
    {
      "aria-hidden": "true",
      className:
        "agent-gui-workbench-dock-icon agent-gui-workbench-dock-icon--single"
    },
    createElement("img", {
      alt: "",
      draggable: false,
      src: input.iconUrl
    })
  );
}

function resolveAgentGuiWorkbenchProviderFromNode(
  node: Parameters<NonNullable<WorkbenchHostDockEntry["matchNode"]>>[0]
): AgentGuiWorkbenchProvider {
  return (
    agentGuiWorkbenchProviderFromIdentifier(node.data.instanceId) ??
    agentGuiWorkbenchProviderFromIdentifier(node.data.dockEntryId) ??
    providerFromState(node.data.snapshotNodeState) ??
    providerFromState(node.data.runtimeNodeState) ??
    agentGuiWorkbenchProviderFromIdentifier(node.data.typeId) ??
    "codex"
  );
}

function providerFromState(state: unknown): AgentGuiWorkbenchProvider | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const provider = (state as { provider?: unknown }).provider;
  return isAgentGuiWorkbenchProvider(provider) ? provider : null;
}

function providerFromActivation(
  activation: unknown
): AgentGuiWorkbenchProvider | null {
  if (!activation || typeof activation !== "object") {
    return null;
  }
  const payload = (activation as { payload?: unknown }).payload;
  return providerFromState(payload);
}

function resolveAgentGuiWorkbenchLaunchPayload(
  request: WorkbenchHostLaunchRequest,
  input: Pick<
    CreateAgentGuiWorkbenchContributionInput,
    "resolveDockLaunchPayload"
  >
): unknown {
  if (
    request.reason !== "dock" ||
    agentGuiWorkbenchDockIdentityFromIdentifier(request.dockEntryId)?.kind !==
      "unifiedAggregate" ||
    !isEmptyAgentGuiWorkbenchDockLaunchPayload(request.payload)
  ) {
    return request.payload;
  }
  return (
    input.resolveDockLaunchPayload?.({
      dockEntryId: request.dockEntryId,
      payload: request.payload,
      reason: request.reason
    }) ?? request.payload
  );
}

function isEmptyAgentGuiWorkbenchDockLaunchPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return true;
  }
  const typed = payload as Record<string, unknown>;
  return (
    typeof typed.agentSessionId !== "string" &&
    typeof typed.draftPrompt !== "string"
  );
}

function resolveUnifiedAgentGuiDockTarget(
  input: Pick<
    BuildAgentGuiDockEntriesInput,
    | "defaultProvider"
    | "defaultProviderTargetId"
    | "providerAvailability"
    | "providerTargetsLoading"
    | "targets"
  >
): AgentGUIProviderTarget | null {
  const targets = normalizeAgentGUIProviderTargets(input.targets, {
    useStaticCatalog:
      input.providerTargetsLoading !== true && input.targets == null
  }).filter(
    (
      target
    ): target is AgentGUIProviderTarget & {
      provider: (typeof agentGuiWorkbenchDefaultDockProviders)[number];
    } =>
      isAgentGuiWorkbenchProvider(target.provider) &&
      isUnifiedAgentGuiDockProvider(target.provider) &&
      target.disabled !== true &&
      isAgentGuiProviderAvailable(target.provider, input.providerAvailability)
  );
  const defaultProviderTargetId = input.defaultProviderTargetId?.trim();
  if (defaultProviderTargetId) {
    const explicitTarget = targets.find(
      (target) => target.targetId === defaultProviderTargetId
    );
    if (explicitTarget) {
      return explicitTarget;
    }
  }

  if (
    input.defaultProvider &&
    isUnifiedAgentGuiDockProvider(input.defaultProvider) &&
    isAgentGuiProviderAvailable(
      input.defaultProvider,
      input.providerAvailability
    )
  ) {
    const target = preferredAgentGuiDockTargetForProvider(
      targets,
      input.defaultProvider
    );
    if (target) {
      return target;
    }
  }

  return targets[0] ?? null;
}

function resolveUnifiedAgentGuiDockProvider(
  input: Pick<
    BuildAgentGuiDockEntriesInput,
    "defaultProvider" | "providerAvailability" | "targets"
  >
): AgentGuiWorkbenchProvider {
  if (
    input.defaultProvider &&
    isUnifiedAgentGuiDockProvider(input.defaultProvider) &&
    isAgentGuiProviderAvailable(
      input.defaultProvider,
      input.providerAvailability
    )
  ) {
    return input.defaultProvider;
  }
  const target = resolveUnifiedAgentGuiDockTarget(input);
  if (target) {
    return target.provider;
  }
  return (
    agentGuiWorkbenchDefaultDockProviders.find((provider) =>
      isAgentGuiProviderAvailable(provider, input.providerAvailability)
    ) ?? "codex"
  );
}

function isUnifiedAgentGuiDockProvider(
  provider: AgentGuiWorkbenchProvider
): provider is (typeof agentGuiWorkbenchDefaultDockProviders)[number] {
  return agentGuiWorkbenchDefaultDockProviders.includes(
    provider as (typeof agentGuiWorkbenchDefaultDockProviders)[number]
  );
}

function preferredAgentGuiDockTargetForProvider(
  targets: readonly AgentGUIProviderTarget[],
  provider: AgentGuiWorkbenchProvider
): AgentGUIProviderTarget | null {
  const providerTargets = targets.filter(
    (target) => target.provider === provider
  );
  return providerTargets[0] ?? null;
}

function isAgentGuiProviderAvailable(
  provider: AgentGuiWorkbenchProvider,
  availability: AgentGuiWorkbenchProviderAvailability | null | undefined
): boolean {
  const value = availability?.[provider];
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "ready" || value === "available";
  }
  if (typeof value.available === "boolean") {
    return value.available;
  }
  return value.status === "ready" || value.status === "available";
}

function providerTargetLaunchPayloadFromRequest(
  payload: unknown,
  expectedProvider: AgentGuiWorkbenchProvider
): {
  agentTargetId: string | null;
  providerTargetId: string | null;
  providerTargetRef: AgentGUIProviderTargetRef | null;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      agentTargetId: null,
      providerTargetId: null,
      providerTargetRef: null
    };
  }
  const agentTargetId = (payload as { agentTargetId?: unknown }).agentTargetId;
  const providerTargetId = (payload as { providerTargetId?: unknown })
    .providerTargetId;
  const providerTargetRef = (payload as { providerTargetRef?: unknown })
    .providerTargetRef;
  return {
    agentTargetId:
      typeof agentTargetId === "string" && agentTargetId.trim()
        ? agentTargetId.trim()
        : null,
    providerTargetId:
      typeof providerTargetId === "string" && providerTargetId.trim()
        ? providerTargetId.trim()
        : null,
    providerTargetRef:
      providerTargetRef &&
      typeof providerTargetRef === "object" &&
      !Array.isArray(providerTargetRef) &&
      (providerTargetRef as { provider?: unknown }).provider ===
        expectedProvider &&
      typeof (providerTargetRef as { kind?: unknown }).kind === "string" &&
      (providerTargetRef as { kind: string }).kind.trim()
        ? {
            ...(providerTargetRef as AgentGUIProviderTargetRef),
            kind: (providerTargetRef as { kind: string }).kind.trim(),
            provider: expectedProvider
          }
        : null
  };
}

function createAgentGuiWorkbenchPreviewContent(input: {
  item: WorkbenchHostDockPopupItemInput;
  label?: string;
  provider?: AgentGuiWorkbenchProvider;
  renderPreview: NonNullable<
    CreateAgentGuiWorkbenchContributionInput["renderPreview"]
  >;
  resolveDockPopupIdentity?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupIdentity"];
  resolveDockPopupTitle?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupTitle"];
}): WorkbenchDockPreviewContent {
  const { externalNodeState, node } = input.item;
  const state = normalizeAgentGuiWorkbenchState(externalNodeState);
  const title =
    input.resolveDockPopupIdentity?.(state)?.title ??
    input.resolveDockPopupTitle?.(state) ??
    node.title;
  const provider =
    input.provider ??
    agentGuiWorkbenchProviderFromIdentifier(node.data.instanceId) ??
    agentGuiWorkbenchProviderFromInstanceId(node.data.instanceId);
  const label = input.label ?? resolveAgentGuiWorkbenchProviderLabel(provider);
  const lines = [label, state.lastActiveAgentSessionId].filter(
    (line): line is string => Boolean(line?.trim())
  );
  return {
    element: input.renderPreview(
      createAgentGuiWorkbenchPreviewBodyContext(input.item),
      {
        nodeTypeId: agentGuiWorkbenchTypeId,
        onStateChange: () => undefined,
        provider
      }
    ),
    kind: "component",
    revision: `${provider}\n${title}\n${lines.join("\n")}`
  };
}

function createAgentGuiWorkbenchPreviewBodyContext(
  input: WorkbenchHostDockPopupItemInput
): WorkbenchHostNodeBodyContext<AgentGuiWorkbenchState | null, unknown> {
  return {
    activation: null,
    displayMode: input.node.displayMode,
    externalNodeState: input.externalNodeState as AgentGuiWorkbenchState | null,
    externalWorkspaceState: input.externalWorkspaceState,
    focus: () => undefined,
    host: input.host,
    instanceId: input.node.data.instanceId,
    instanceKey: input.node.data.instanceKey ?? null,
    isFocused: false,
    node: input.node,
    previewViewport: input.previewViewport,
    setNodeRuntimeState: () => undefined,
    setSnapshotNodeState: () => undefined
  };
}
