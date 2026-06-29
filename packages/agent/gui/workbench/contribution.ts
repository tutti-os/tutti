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
import { AgentGuiWorkbenchHeader } from "./header.ts";
import {
  agentGuiWorkbenchDockEntryId,
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchTypeId,
  createAgentGuiWorkbenchLaunchDescriptor
} from "./launch.ts";
import {
  agentGuiWorkbenchProviderFromInstanceId,
  createAgentGuiWorkbenchNodeStateSource,
  normalizeAgentGuiWorkbenchNodeState,
  normalizeAgentGuiWorkbenchState
} from "./state.ts";
import {
  agentGuiWorkbenchProviderLabels,
  agentGuiWorkbenchProviders,
  isAgentGuiWorkbenchDefaultDockProvider,
  resolveAgentGuiWorkbenchProviderLabel
} from "./providerCatalog.ts";
import type {
  AgentGuiWorkbenchNodeState,
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";

export const agentGuiWorkbenchDefaultNodeFrame: WorkbenchFrame = {
  height: 560,
  width: 1040,
  x: 140,
  y: 48
};

export const agentGuiWorkbenchDefaultUsableHeightRatio = 0.7;
export const agentGuiWorkbenchCompactVisibleAreaRatio = 0.9;

export const AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT =
  "tutti:agent-gui-workbench-conversation-rail-toggle";

export const AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT =
  "tutti:agent-gui-workbench-new-conversation";

export interface AgentGuiWorkbenchConversationRailToggleDetail {
  conversationRailCollapsed: boolean;
  instanceId: string;
}

export interface AgentGuiWorkbenchNewConversationDetail {
  instanceId: string;
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
  restore: "Restore"
};

export interface AgentGuiWorkbenchRenderBodyHelpers {
  nodeTypeId: string;
  onStateChange(state: AgentGuiWorkbenchState): void;
  provider: AgentGuiWorkbenchProvider;
}

export interface CreateAgentGuiWorkbenchContributionInput {
  copy?: AgentGuiWorkbenchContributionCopyOverrides;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  dockSectionId?: string;
  frame?: WorkbenchFrame;
  id?: string;
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
  resolveDockEntryVisibility?: (
    provider: AgentGuiWorkbenchProvider
  ) => WorkbenchHostDockEntry["visibility"];
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
    dockEntries: agentGuiWorkbenchProviders.map((provider, index) =>
      createAgentGuiWorkbenchDockEntry({
        label: agentGuiWorkbenchProviderLabels[provider],
        iconUrl:
          input.dockIconUrls?.[provider] ?? agentGuiDockIconUrls[provider],
        order: index,
        provider,
        renderPreview: input.renderPreview,
        resolveDockPopupTitle: input.resolveDockPopupTitle,
        sectionId: input.dockSectionId ?? "agents",
        visibility:
          input.resolveDockEntryVisibility?.(provider) ??
          (isAgentGuiWorkbenchDefaultDockProvider(provider)
            ? "always"
            : "never")
      })
    ),
    externalStateSource: nodeStateSource.externalStateSource,
    id: input.id ?? "workspace-agent-gui",
    nodes: [
      {
        frame,
        instance: { mode: "multi" },
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
              provider: agentGuiWorkbenchProviderFromInstanceId(
                context.instanceId
              )
            }
          ),
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
          const provider = agentGuiWorkbenchProviderFromInstanceId(instanceId);
          const providerTitle = resolveAgentGuiWorkbenchProviderLabel(provider);
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
          const conversationTitle =
            input.resolveDockPopupTitle?.(workbenchState) ??
            nodeState.lastActiveConversationTitle ??
            null;
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
            conversationTitle,
            conversationRailWidthPx,
            displayMode,
            iconUrl: agentGuiDockIconUrls[provider],
            isConversationRailAutoCollapsed,
            isConversationRailCollapsed,
            title: providerTitle,
            windowActions: {
              close: windowActions.close,
              minimize: windowActions.minimize,
              toggleDisplayMode: windowActions.toggleDisplayMode
            },
            ...dragHandleProps,
            onCreateConversation: announceNewConversation,
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

      const {
        activation,
        dockEntryId,
        instanceId: descriptorInstanceId,
        provider,
        reuseDockEntryNode,
        targetAgentSessionId
      } = createAgentGuiWorkbenchLaunchDescriptor(request);
      // Locate an already-open node currently showing this session (its launch
      // instanceId may differ from the session-keyed one, e.g. a conversation
      // started fresh as a draft) so we focus it instead of opening a duplicate.
      const existingInstanceId = targetAgentSessionId
        ? nodeStateSource.findInstanceIdByAgentSessionId(targetAgentSessionId)
        : null;
      const instanceId = existingInstanceId ?? descriptorInstanceId;
      const title = resolveAgentGuiWorkbenchProviderLabel(provider);
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
        defaultFrame,
        dockEntryId,
        framePolicy: isAgentGuiWorkbenchCompactVisibleFrame(defaultFrame, frame)
          ? "absolute"
          : "cascade-same-type-centered",
        instanceId,
        reuseDockEntryNode,
        title,
        typeId: agentGuiWorkbenchTypeId
      };
    }
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
  const shouldUseCompactWidth = layoutFrame.width < input.frame.width;
  const shouldUseCompactHeight =
    layoutFrame.height <
    input.frame.height / agentGuiWorkbenchCompactVisibleAreaRatio;

  if (shouldUseCompactWidth || shouldUseCompactHeight) {
    const width = shouldUseCompactWidth
      ? Math.round(layoutFrame.width * agentGuiWorkbenchCompactVisibleAreaRatio)
      : input.frame.width;
    const height = Math.round(
      layoutFrame.height * agentGuiWorkbenchCompactVisibleAreaRatio
    );

    return {
      height,
      width,
      x: Math.round(layoutFrame.x + (layoutFrame.width - width) / 2),
      y: Math.round(layoutFrame.y + (layoutFrame.height - height) / 2)
    };
  }

  return {
    ...input.frame,
    height: defaultHeight
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
  iconUrl?: string;
  label: string;
  order: number;
  provider: AgentGuiWorkbenchProvider;
  renderPreview?: CreateAgentGuiWorkbenchContributionInput["renderPreview"];
  resolveDockPopupTitle?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupTitle"];
  sectionId: string;
  visibility: WorkbenchHostDockEntry["visibility"];
}): WorkbenchHostDockEntry {
  return {
    icon: createElement("img", {
      alt: "",
      draggable: false,
      src: input.iconUrl
    }),
    iconSize: "large",
    id: agentGuiWorkbenchDockEntryId(input.provider),
    label: input.label,
    launchBehavior: "enabled",
    launchPayload: { provider: input.provider },
    matchNode: (node) =>
      node.data.typeId === agentGuiWorkbenchTypeId &&
      agentGuiWorkbenchProviderFromIdentifier(node.data.instanceId) ===
        input.provider,
    order: input.order,
    providePopupItemPreview: (item) =>
      input.renderPreview
        ? createAgentGuiWorkbenchPreviewContent({
            item,
            label: input.label,
            provider: input.provider,
            renderPreview: input.renderPreview,
            resolveDockPopupTitle: input.resolveDockPopupTitle
          })
        : null,
    resolvePopupItem: ({ externalNodeState }) => {
      const title =
        input.resolveDockPopupTitle?.(
          normalizeAgentGuiWorkbenchState(externalNodeState)
        ) ?? null;
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

function createAgentGuiWorkbenchPreviewContent(input: {
  item: WorkbenchHostDockPopupItemInput;
  label?: string;
  provider?: AgentGuiWorkbenchProvider;
  renderPreview: NonNullable<
    CreateAgentGuiWorkbenchContributionInput["renderPreview"]
  >;
  resolveDockPopupTitle?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupTitle"];
}): WorkbenchDockPreviewContent {
  const { externalNodeState, node } = input.item;
  const state = normalizeAgentGuiWorkbenchState(externalNodeState);
  const title = input.resolveDockPopupTitle?.(state) ?? node.title;
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
