import { createElement, type ReactNode } from "react";
import {
  getWorkbenchLayoutFrame,
  type WorkbenchContribution,
  type WorkbenchFrame,
  type WorkbenchHostDockEntry,
  type WorkbenchHostDockPopupItemInput,
  type WorkbenchHostLaunchRequest,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import {
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

export interface AgentGuiWorkbenchConversationRailToggleDetail {
  conversationRailCollapsed: boolean;
  instanceId: string;
}

export interface AgentGuiWorkbenchContributionCopy {
  collapseConversationRail: string;
  expandConversationRail: string;
  fallbackAgentLabel: string;
  nodeTitle: string;
}

export type AgentGuiWorkbenchContributionCopyOverrides =
  Partial<AgentGuiWorkbenchContributionCopy>;

export const agentGuiWorkbenchDefaultCopy: AgentGuiWorkbenchContributionCopy = {
  collapseConversationRail: "Collapse conversation rail",
  expandConversationRail: "Expand conversation rail",
  fallbackAgentLabel: "Agent",
  nodeTitle: "Agent"
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
          defaultActions,
          dragHandleProps,
          externalNodeState,
          instanceId,
          isFocused,
          node,
          surfaceSize,
          windowActions
        }) => {
          const provider = agentGuiWorkbenchProviderFromInstanceId(instanceId);
          const title = resolveAgentGuiWorkbenchProviderLabel(provider);
          const workbenchState = normalizeAgentGuiWorkbenchState(
            externalNodeState ?? node.data.runtimeNodeState
          );
          const nodeState = normalizeAgentGuiWorkbenchNodeState(
            workbenchState,
            provider
          );
          const isConversationRailAutoCollapsed =
            shouldAutoCollapseAgentGUIConversationRail(node.frame.width);
          const isConversationRailCollapsed =
            nodeState.conversationRailCollapsed === true ||
            isConversationRailAutoCollapsed;
          const persistConversationRailCollapsed = (collapsed: boolean) => {
            nodeStateSource.writeNodeState({
              instanceId,
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

          return createElement(AgentGuiWorkbenchHeader, {
            copy,
            defaultActions,
            isConversationRailAutoCollapsed,
            isConversationRailCollapsed,
            title,
            ...dragHandleProps,
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
            kind: "snapshot"
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
        instanceId,
        provider,
        reuseDockEntryNode,
        targetAgentSessionId
      } = createAgentGuiWorkbenchLaunchDescriptor(request);
      const title = resolveAgentGuiWorkbenchProviderLabel(provider);
      if (targetAgentSessionId) {
        const previousState = nodeStateSource.readNodeState({
          instanceId,
          typeId: agentGuiWorkbenchTypeId
        });
        nodeStateSource.writeNodeState({
          instanceId,
          state: {
            ...(previousState ?? normalizeAgentGuiWorkbenchState(null)),
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

  if (
    layoutFrame.width < input.frame.width ||
    layoutFrame.height < input.frame.height
  ) {
    const width = Math.round(
      layoutFrame.width * agentGuiWorkbenchCompactVisibleAreaRatio
    );
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
    providePopupItemPreview: (item) => {
      if (!input.renderPreview) {
        return null;
      }
      const { externalNodeState, node } = item;
      const state =
        (externalNodeState as
          | Partial<
              AgentGuiWorkbenchState & { conversationCount?: number | null }
            >
          | null
          | undefined) ?? {};
      const title =
        resolveAgentGuiWorkbenchDockPopupTitle(externalNodeState) ?? node.title;
      const lines = [input.label, state.lastActiveAgentSessionId].filter(
        (line): line is string => Boolean(line?.trim())
      );
      const revision = `${input.provider}\n${title}\n${lines.join("\n")}`;
      return {
        element: input.renderPreview(
          createAgentGuiWorkbenchPreviewBodyContext(item),
          {
            nodeTypeId: agentGuiWorkbenchTypeId,
            onStateChange: () => undefined,
            provider: input.provider
          }
        ),
        kind: "component",
        revision
      };
    },
    resolvePopupItem: ({ externalNodeState }) => {
      const title = resolveAgentGuiWorkbenchDockPopupTitle(externalNodeState);
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

function resolveAgentGuiWorkbenchDockPopupTitle(state: unknown): string | null {
  const title = (state as Partial<AgentGuiWorkbenchState> | null)
    ?.lastActiveConversationTitle;
  return typeof title === "string" && title.trim() ? title.trim() : null;
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
    setNodeRuntimeState: () => undefined,
    setSnapshotNodeState: () => undefined
  };
}
