import type { Dispatch, SetStateAction } from "react";
import type { DesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import type { DesktopFusionWindowKind } from "@shared/contracts/fusion.ts";
import type {
  WorkbenchContribution,
  WorkbenchHostActivation,
  WorkbenchHostHandle,
  WorkbenchHostLaunchInput,
  WorkbenchHostLaunchResult,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition,
  WorkbenchNode,
  WorkbenchState
} from "@tutti-os/workbench-surface";
import { createStandaloneWorkbenchNodeId } from "./fusionWindowModel.ts";
import type {
  WorkspaceSettingsGeneralFocusAnchor,
  WorkspaceSettingsSectionID
} from "./workspaceSettingsTypes.ts";

export const emptyStandaloneWorkbenchState = createEmptyWorkbenchState();

export interface ResolvedStandaloneNode {
  activation: WorkbenchHostActivation | null;
  contribution: WorkbenchContribution;
  definition: WorkbenchHostNodeDefinition;
  instanceId: string;
  instanceKey: string | null;
  nodeId: string;
  title: string;
}

export async function resolveStandaloneNode(input: {
  contributions: readonly WorkbenchContribution[];
  kind: DesktopFusionWindowKind;
  launchPayload?: unknown;
  resourceId?: string | null;
  typeId: string;
  workspaceId: string;
}): Promise<ResolvedStandaloneNode | null> {
  const contribution = input.contributions.find((candidate) =>
    candidate.nodes?.some((node) => node.typeId === input.typeId)
  );
  const definition = contribution?.nodes?.find(
    (node) => node.typeId === input.typeId
  );
  if (!contribution || !definition) {
    return null;
  }
  const payload = mergeResourceIntoLaunchPayload({
    kind: input.kind,
    launchPayload: input.launchPayload,
    resourceId: input.resourceId
  });
  const request = {
    layoutConstraints: emptyStandaloneWorkbenchState.layoutConstraints,
    payload,
    reason: "host" as const,
    surfaceSize: emptyStandaloneWorkbenchState.surfaceSize,
    typeId: input.typeId,
    workspaceId: input.workspaceId
  };
  let result: WorkbenchHostLaunchResult | null = null;
  for (const candidate of input.contributions) {
    const resolved = await candidate.onLaunchRequest?.(request);
    if (resolved) {
      result = resolved;
      break;
    }
  }
  if (!result) {
    return null;
  }
  const instanceKey = result.instanceKey?.trim() || null;
  const activationInput =
    result.activation ??
    resolveStandaloneInitialActivation(input.kind, payload);
  const activation = activationInput
    ? { ...activationInput, sequence: 1 }
    : null;
  return {
    activation,
    contribution,
    definition,
    instanceId: result.instanceId,
    instanceKey,
    nodeId: createStandaloneWorkbenchNodeId({
      instanceId: result.instanceId,
      typeId: result.typeId
    }),
    title: result.title ?? definition.title
  };
}

export function canResolveStandaloneFusionNode(input: {
  appCenterLoadStatus: string;
  appCenterWorkspaceId: string | null;
  kind: DesktopFusionWindowKind;
  workspaceId: string;
}): boolean {
  return (
    input.kind !== "workspace-app" ||
    (input.appCenterLoadStatus === "ready" &&
      input.appCenterWorkspaceId === input.workspaceId)
  );
}

export function shouldCloseStandaloneAfterWorkspaceAppHandoff(input: {
  handoffWindowOpened: boolean;
  kind: DesktopFusionWindowKind;
  resolvedNode: ResolvedStandaloneNode | null;
}): boolean {
  return (
    input.kind === "workspace-app" &&
    input.handoffWindowOpened &&
    input.resolvedNode === null
  );
}

export function readResourceIdFromLaunchPayload(
  kind: DesktopFusionWindowKind,
  payload: unknown
): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const typed = payload as Record<string, unknown>;
  const candidate =
    kind === "agent"
      ? typed.agentSessionId
      : kind === "terminal"
        ? typed.sessionId
        : kind === "workspace-app"
          ? typed.appId
          : kind === "file-preview"
            ? typed.path
            : null;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

export function readResourceIdFromNode(
  kind: DesktopFusionWindowKind,
  instanceId: string
): string | null {
  if (kind === "terminal") {
    return instanceId;
  }
  if (kind === "workspace-app" && instanceId.startsWith("app:")) {
    return decodeURIComponent(instanceId.slice("app:".length));
  }
  return null;
}

export function createStandaloneWorkbenchHost(input: {
  approveClose(): Promise<void>;
  getNode(): WorkbenchNode<WorkbenchHostNodeData> | null;
  launchNode(request: WorkbenchHostLaunchInput): Promise<string | null>;
  minimize(): Promise<void>;
  setActivation: Dispatch<SetStateAction<WorkbenchHostActivation | null>>;
  setRuntimeNodeState: (state: unknown) => void;
  setSnapshotNodeState: (state: unknown) => void;
  setTitle: (title: string) => void;
  toggleMaximize(): Promise<void>;
}): WorkbenchHostHandle {
  return {
    activateNode(_target, activation) {
      input.setActivation({ ...activation, sequence: Date.now() });
    },
    clearNodeActivation(_nodeId, sequence) {
      input.setActivation((current) =>
        current?.sequence === sequence ? null : current
      );
    },
    closeNode() {
      void input.approveClose();
    },
    async collectWindowCloseEffects() {
      return [];
    },
    dispose() {},
    exitFullscreenNode() {
      void input.toggleMaximize();
    },
    focusNode() {},
    getSnapshot() {
      const node = input.getNode();
      return node
        ? {
            ...emptyStandaloneWorkbenchState,
            nodeStack: [node.id],
            nodes: [node]
          }
        : emptyStandaloneWorkbenchState;
    },
    launchNode: input.launchNode,
    async load() {},
    minimizeNode() {
      void input.minimize();
    },
    requestNodeClose() {
      void input.approveClose();
    },
    reconcileProjectedNodes() {},
    setNodeRuntimeState(_nodeId, state) {
      input.setRuntimeNodeState(state);
    },
    setNodeSizeConstraints() {},
    setNodeTitle(_nodeId, title) {
      input.setTitle(title);
    },
    setSnapshotNodeState(_nodeId, state) {
      input.setSnapshotNodeState(state);
    }
  };
}

export function readStandaloneSettingsRequest(payload: unknown): {
  anchor?: WorkspaceSettingsGeneralFocusAnchor;
  provider?: ReturnType<typeof readSettingsProvider>;
  section?: WorkspaceSettingsSectionID;
  tab?: string;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const typed = payload as Record<string, unknown>;
  const anchor = readSettingsAnchor(typed.anchor);
  const provider = readSettingsProvider(typed.provider);
  const section = readSettingsSection(typed.section);
  return {
    ...(anchor ? { anchor } : {}),
    ...(provider ? { provider } : {}),
    ...(section ? { section } : {}),
    ...(typeof typed.tab === "string" ? { tab: typed.tab } : {})
  };
}

function resolveStandaloneInitialActivation(
  kind: DesktopFusionWindowKind,
  payload: unknown
): Omit<WorkbenchHostActivation, "sequence"> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const typed = payload as Record<string, unknown>;
  if (kind === "browser" && typeof typed.url === "string") {
    return { payload: { url: typed.url }, type: "open-url" };
  }
  if (kind === "files" && typeof typed.path === "string") {
    return {
      payload: {
        mode: typed.mode === "open-directory" ? "open-directory" : "reveal",
        path: typed.path
      },
      type: "reveal-file"
    };
  }
  if (kind === "issue-manager" && typeof typed.issueId === "string") {
    return { payload, type: "open-workspace-issue" };
  }
  return null;
}

function mergeResourceIntoLaunchPayload(input: {
  kind: DesktopFusionWindowKind;
  launchPayload?: unknown;
  resourceId?: string | null;
}): unknown {
  if (!input.resourceId) {
    return input.launchPayload;
  }
  const payload =
    input.launchPayload && typeof input.launchPayload === "object"
      ? input.launchPayload
      : {};
  if (input.kind === "terminal") {
    return { ...payload, sessionId: input.resourceId };
  }
  if (input.kind === "workspace-app") {
    return { ...payload, appId: input.resourceId };
  }
  return input.launchPayload;
}

function createEmptyWorkbenchState(): WorkbenchState<WorkbenchHostNodeData> {
  return {
    activeDragNodeId: null,
    activeResizeNodeId: null,
    activeSnapTarget: null,
    layoutConstraints: {
      minHeight: 160,
      minWidth: 280,
      safeArea: { bottom: 0, left: 0, right: 0, top: 0 },
      surfacePadding: 0
    },
    lockedLayout: null,
    nodeStack: [],
    nodes: [],
    surfaceSize: { height: 720, width: 1024 }
  };
}

function readSettingsProvider(value: unknown) {
  return typeof value === "string" && settingsAgentProviders.has(value)
    ? (value as DesktopAgentGUIProvider)
    : undefined;
}

function readSettingsAnchor(
  value: unknown
): WorkspaceSettingsGeneralFocusAnchor | undefined {
  return value === "browser-use" || value === "computer-use"
    ? value
    : undefined;
}

function readSettingsSection(
  value: unknown
): WorkspaceSettingsSectionID | undefined {
  return typeof value === "string" && settingsSections.has(value)
    ? (value as WorkspaceSettingsSectionID)
    : undefined;
}

const settingsAgentProviders = new Set<string>([
  "claude-code",
  "codex",
  "cursor",
  "hermes",
  "nexight",
  "openclaw",
  "opencode",
  "tutti-agent"
]);

const settingsSections = new Set<string>([
  "about",
  "account",
  "agent",
  "appearance",
  "apps",
  "developer",
  "general",
  "lab"
]);
