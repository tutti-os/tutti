import { createElement, type ReactNode } from "react";
import {
  createMultiInstanceDockEntryOptions,
  getWorkbenchLayoutFrame,
  type WorkbenchDockPreviewContent,
  type WorkbenchFrame,
  type WorkbenchHostDockEntry,
  type WorkbenchHostDockPopupItemInput,
  type WorkbenchHostLaunchRequest,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import { agentGuiDockIconUrls } from "../dockIcons.ts";
import {
  agentGuiWorkbenchDockIdentityFromIdentifier,
  agentGuiWorkbenchTypeId,
  agentGuiWorkbenchUnifiedDockEntryId
} from "./launch.ts";
import { normalizeAgentGuiWorkbenchState } from "./state.ts";
import {
  agentGuiWorkbenchDefaultDockProviders,
  isAgentGuiWorkbenchProvider,
  resolveAgentGuiWorkbenchProviderLabel
} from "./providerCatalog.ts";
import type {
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";
import {
  normalizeAgentGUIAgents,
  projectAgentGUIAgentsToTargets
} from "../agents.ts";
import type {
  AgentGUIAgentDirectoryPort,
  AgentGUIAgentTarget
} from "../types.ts";
import type {
  AgentGuiWorkbenchContributionCopy,
  AgentGuiWorkbenchContributionCopyOverrides,
  CreateAgentGuiWorkbenchContributionInput
} from "./contribution.ts";

export const agentGuiWorkbenchDefaultNodeFrame: WorkbenchFrame = {
  height: 560,
  width: 1040,
  x: 140,
  y: 48
};

export const agentGuiWorkbenchDefaultUsableWidthRatio = 0.9;
export const agentGuiWorkbenchDefaultUsableHeightRatio = 0.9;
export const agentGuiWorkbenchCompactVisibleAreaRatio = 0.9;
export const agentGuiWorkbenchNewWindowCascadeOffset = { x: 180, y: 88 };
export const agentGuiWorkbenchProviderRailWidthPx = 52;
const agentGuiWorkbenchUnifiedDockTileProviders = [
  "codex",
  "claude-code",
  "tutti-agent"
] as const satisfies readonly AgentGuiWorkbenchProvider[];
export const agentGuiWorkbenchDefaultCopy: AgentGuiWorkbenchContributionCopy = {
  collapseConversationRail: "Hide sidebar",
  close: "Close",
  expandConversationRail: "Show sidebar",
  fallbackAgentLabel: "Agent",
  maximize: "Maximize",
  minimize: "Minimize",
  newConversation: "New conversation",
  nodeTitle: "Agent",
  openDetachedWindow: "Open in detached window",
  restore: "Restore",
  untitledConversation: "Untitled conversation"
};
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
  agentDirectory: AgentGUIAgentDirectoryPort;
  defaultProvider?: AgentGuiWorkbenchProvider | null;
  dockEntryId?: string;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  label?: string;
  order?: number;
  providerAvailability?: AgentGuiWorkbenchProviderAvailability;
  renderPreview?: CreateAgentGuiWorkbenchContributionInput["renderPreview"];
  resolveDockPopupIdentity?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupIdentity"];
  resolveDockPopupTitle?: CreateAgentGuiWorkbenchContributionInput["resolveDockPopupTitle"];
  sectionId?: string;
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
      agentDirectory: input.agentDirectory,
      dockEntryId: input.dockEntryId ?? agentGuiWorkbenchUnifiedDockEntryId(),
      icon: input.unifiedDockIconUrl
        ? createAgentGuiWorkbenchUnifiedDockIcon({
            iconUrl: input.unifiedDockIconUrl
          })
        : createAgentGuiWorkbenchLaunchpadStyleDockIcon({
            tileIconUrls: unifiedTileIconUrls
          }),
      label: input.label ?? agentGuiWorkbenchDefaultCopy.nodeTitle,
      launchPayload,
      order: input.order ?? 0,
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
    "agentDirectory" | "defaultProvider" | "providerAvailability"
  >
): {
  provider: AgentGuiWorkbenchProvider;
  agentTargetId?: string;
} {
  const target = resolveUnifiedAgentGuiDockTarget(input);
  if (target) {
    return {
      provider: target.provider,
      agentTargetId: target.agentTargetId ?? target.targetId
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

export function isAgentGuiWorkbenchCompactVisibleFrame(
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
  agentDirectory: AgentGUIAgentDirectoryPort;
  dockEntryId: string;
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
  const launchPayload = input.launchPayload ?? { provider: input.provider };
  return {
    ...createMultiInstanceDockEntryOptions(launchPayload, {
      allowNewWindowInDockPopup: false
    }),
    icon: input.icon,
    iconSize: "large",
    id: input.dockEntryId,
    label: input.label,
    order: input.order,
    providePopupItemPreview: (item) =>
      input.renderPreview
        ? createAgentGuiWorkbenchPreviewContent({
            agentDirectory: input.agentDirectory,
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

export function resolveAgentGuiWorkbenchProviderIconUrl(input: {
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  provider: AgentGuiWorkbenchProvider;
}): string {
  return (
    input.dockIconUrls?.[input.provider] ??
    agentGuiDockIconUrls[input.provider] ??
    ""
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

export function providerFromState(
  state: unknown
): AgentGuiWorkbenchProvider | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const provider = (state as { provider?: unknown }).provider;
  return isAgentGuiWorkbenchProvider(provider) ? provider : null;
}

export function providerFromActivation(
  activation: unknown
): AgentGuiWorkbenchProvider | null {
  if (!activation || typeof activation !== "object") {
    return null;
  }
  const payload = (activation as { payload?: unknown }).payload;
  return providerFromState(payload);
}

export function resolveAgentGuiWorkbenchLaunchPayload(
  request: WorkbenchHostLaunchRequest,
  input: {
    agentDirectory: AgentGUIAgentDirectoryPort;
    defaultProvider?: AgentGuiWorkbenchProvider | null;
    providerAvailability?: AgentGuiWorkbenchProviderAvailability;
  }
): unknown | null {
  if (hasAgentSessionId(request.payload)) {
    return request.payload;
  }
  const snapshot = input.agentDirectory.getSnapshot();
  const agents = normalizeAgentGUIAgents(snapshot.agents);
  const payload = isRecord(request.payload) ? request.payload : {};
  const isUnifiedDockLaunch =
    request.reason === "dock" &&
    agentGuiWorkbenchDockIdentityFromIdentifier(request.dockEntryId)?.kind ===
      "unifiedAggregate";
  const explicitAgentTargetId = isUnifiedDockLaunch
    ? null
    : readTrimmedString(payload.agentTargetId);
  if (explicitAgentTargetId) {
    const explicitAgent = agents.find(
      (agent) =>
        agent.agentTargetId === explicitAgentTargetId &&
        agent.availability.status === "ready"
    );
    if (
      !explicitAgent ||
      !isAgentGuiWorkbenchProvider(explicitAgent.provider)
    ) {
      return null;
    }
    return {
      ...payload,
      agentTargetId: explicitAgent.agentTargetId,
      provider: explicitAgent.provider
    };
  }
  const requestedProvider = providerFromState(payload);
  const resolved = resolveAgentGuiUnifiedDockLaunchPayload({
    agentDirectory: input.agentDirectory,
    defaultProvider: requestedProvider ?? input.defaultProvider,
    providerAvailability: input.providerAvailability
  });
  if (!resolved.agentTargetId) {
    return null;
  }
  return { ...payload, ...resolved };
}

function hasAgentSessionId(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return readTrimmedString(payload.agentSessionId) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveUnifiedAgentGuiDockTarget(
  input: Pick<
    BuildAgentGuiDockEntriesInput,
    "agentDirectory" | "defaultProvider" | "providerAvailability"
  >
): AgentGUIAgentTarget | null {
  const targets = projectAgentGUIAgentsToTargets(
    normalizeAgentGUIAgents(input.agentDirectory.getSnapshot().agents)
  ).filter(
    (
      target
    ): target is AgentGUIAgentTarget & {
      provider: (typeof agentGuiWorkbenchDefaultDockProviders)[number];
    } =>
      isAgentGuiWorkbenchProvider(target.provider) &&
      isUnifiedAgentGuiDockProvider(target.provider) &&
      target.disabled !== true &&
      isAgentGuiProviderAvailable(target.provider, input.providerAvailability)
  );
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
    "agentDirectory" | "defaultProvider" | "providerAvailability"
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
  targets: readonly AgentGUIAgentTarget[],
  provider: AgentGuiWorkbenchProvider
): AgentGUIAgentTarget | null {
  const agentTargets = targets.filter((target) => target.provider === provider);
  return agentTargets[0] ?? null;
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

export function providerTargetLaunchPayloadFromRequest(
  payload: unknown,
  _expectedProvider: AgentGuiWorkbenchProvider
): {
  agentTargetId: string | null;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      agentTargetId: null
    };
  }
  const agentTargetId = (payload as { agentTargetId?: unknown }).agentTargetId;
  const providerTargetId = (payload as { providerTargetId?: unknown })
    .providerTargetId;
  return {
    agentTargetId:
      typeof agentTargetId === "string" && agentTargetId.trim()
        ? agentTargetId.trim()
        : typeof providerTargetId === "string" && providerTargetId.trim()
          ? providerTargetId.trim()
          : null
  };
}

export function createAgentGuiWorkbenchPreviewContent(input: {
  agentDirectory: AgentGUIAgentDirectoryPort;
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
  const agentTargetId = state.agentTargetId?.trim() ?? "";
  const agent = input.agentDirectory
    .getSnapshot()
    .agents.find((candidate) => candidate.agentTargetId === agentTargetId);
  const provider = input.provider ?? agent?.provider ?? null;
  const label =
    input.label ??
    agent?.name ??
    (provider ? resolveAgentGuiWorkbenchProviderLabel(provider) : node.title);
  const lines = [label, state.lastActiveAgentSessionId].filter(
    (line): line is string => Boolean(line?.trim())
  );
  return {
    element: input.renderPreview(
      createAgentGuiWorkbenchPreviewBodyContext(input.item),
      {
        agentDirectory: input.agentDirectory,
        nodeTypeId: agentGuiWorkbenchTypeId,
        onStateChange: () => undefined,
        agentTargetId: agentTargetId || null,
        provider
      }
    ),
    kind: "component",
    revision: `${agentTargetId}\n${provider ?? ""}\n${title}\n${lines.join("\n")}`
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
    isDragging: false,
    isFocused: false,
    isResizing: false,
    node: input.node,
    previewViewport: input.previewViewport,
    setNodeRuntimeState: () => undefined,
    setSnapshotNodeState: () => undefined
  };
}
