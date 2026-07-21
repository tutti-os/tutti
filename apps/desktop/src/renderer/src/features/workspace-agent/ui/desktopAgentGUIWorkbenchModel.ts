import type {
  AgentActivityRuntime,
  AgentGUIAgentDirectorySnapshot,
  AgentGUIAllAgentsPresentation,
  AgentGUIProvider,
  AgentGUIComposerAppendRequest,
  AgentGUIAgentsEmptyRenderer,
  AgentGUIProps,
  AgentHostInputApi
} from "@tutti-os/agent-gui";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import {
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
  type AgentGuiWorkbenchConversationRailToggleDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { WorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type {
  WorkbenchDockPreviewCache,
  WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../services/agentProviderStatusService.interface";
import { Toast } from "@renderer/lib/toast";
import type { DesktopComputerUseApi, DesktopRuntimeApi } from "@preload/types";
import type { DesktopComputerUseStatus } from "@shared/contracts/ipc";
import type {
  DesktopAgentGUINodeState,
  DesktopAgentGUIWorkbenchState
} from "../desktopAgentGUINodeState";
import type { DesktopAgentGUIPrefillPromptRequest } from "../services/desktopAgentGUIPrefillPromptActivation.ts";

export const DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT =
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT;

export type DesktopAgentGUIConversationRailToggleDetail =
  AgentGuiWorkbenchConversationRailToggleDetail;

export interface DesktopAgentGUISurfaceContext {
  activation: WorkbenchHostNodeBodyContext["activation"];
  displayMode: WorkbenchHostNodeBodyContext["displayMode"];
  frame: WorkbenchHostNodeBodyContext["node"]["frame"];
  host: WorkbenchHostNodeBodyContext["host"];
  instanceId: string;
  isDragging: boolean;
  isFocused: boolean;
  isMinimized: boolean;
  isResizing: boolean;
  nodeId: string;
  nodeTitle: string;
  presentationMode: WorkbenchHostNodeBodyContext["presentationMode"];
  state: unknown;
}

export interface DesktopAgentGUIWorkbenchBodyProps {
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi: AgentHostInputApi;
  appCenterService: IWorkspaceAppCenterService;
  agentProviderStatusService?: IAgentProviderStatusService;
  context: WorkbenchHostNodeBodyContext;
  computerUseApi?: Pick<DesktopComputerUseApi, "checkStatus">;
  composerAppendRequest?: AgentGUIComposerAppendRequest | null;
  conversationRailAutoCollapseWidthPx?: number | null;
  dockPreviewCache: WorkbenchDockPreviewCache;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onCapabilitySettingsRequest?: AgentGUIProps["hostActions"]["onCapabilitySettingsRequest"];
  onOpenAgentConversationWindow?: (input: {
    agentSessionId: string;
    agentTargetId: string | null;
    provider: DesktopAgentGUINodeState["provider"];
    workspaceId: string;
  }) => Promise<void> | void;
  onStateChange: (state: DesktopAgentGUIWorkbenchState) => void;
  prefillPromptBootstrapRequest?: DesktopAgentGUIPrefillPromptRequest | null;
  previewMode?: boolean;
  providerStatusBootstrapSnapshot?: AgentProviderStatusSnapshot | null;
  agentDirectory: AgentGUIAgentDirectorySnapshot;
  allAgentsPresentation?: AgentGUIAllAgentsPresentation | null;
  renderAgentsEmpty?: AgentGUIAgentsEmptyRenderer;
  comingSoonAgentProviders?: readonly AgentGUIProvider[];
  defaultAgentTargetId?: string | null;
  contextMentionProviders: readonly AgentContextMentionProvider[];
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  trackAgentProviderChatReady?: (input: { provider: string }) => Promise<void>;
  onEngagementEvent?: AgentGUIProps["hostActions"]["onEngagementEvent"];
  trackWorkspaceFileReferences?: AgentGUIProps["workspace"]["onFileReferencesAdded"];
  workspaceFileReferenceAdapter: NonNullable<
    AgentGUIProps["workspace"]["fileReferenceAdapter"]
  >;
  resolveExternalPromptEntries: NonNullable<
    AgentGUIProps["workspace"]["resolveExternalPromptEntries"]
  >;
  prepareExternalPromptFiles: NonNullable<
    AgentGUIProps["workspace"]["prepareExternalPromptFiles"]
  >;
  onRequestGitBranches: NonNullable<
    AgentGUIProps["workspace"]["onRequestGitBranches"]
  >;
  referenceSourceAggregator?: AgentGUIProps["workspace"]["referenceSourceAggregator"];
  renderSidebarFooter?: AgentGUIProps["renderSlots"]["sidebarFooter"];
  resolveWorkspaceReferenceEntryIconUrl?: AgentGUIProps["workspace"]["resolveReferenceEntryIconUrl"];
  resolveMentionReferenceTarget?: AgentGUIProps["workspace"]["resolveMentionReferenceTarget"];
  resolveWorkspaceReferenceInitialTarget?: AgentGUIProps["workspace"]["resolveReferenceInitialTarget"];
  workspaceId: string;
}

export type DesktopAgentGUISurfaceProps = Omit<
  DesktopAgentGUIWorkbenchBodyProps,
  "context"
> & {
  surface: DesktopAgentGUISurfaceContext;
};

export function resolveComputerUseAuthorizationState(
  status: DesktopComputerUseStatus | null
): "authorized" | "needs-authorization" | "unknown" | null {
  if (!status?.installed) {
    return null;
  }
  return status.authorization;
}
export const DESKTOP_AGENT_GUI_AGENT_SETTINGS = {
  avoidGroupingEdits: false
} satisfies NonNullable<AgentGUIProps["workspace"]["agentSettings"]>;
export const DESKTOP_AGENT_GUI_NOOP = (): void => {};
export function handleDesktopAgentGUIShowMessage(
  message: string,
  tone?: "info" | "warning" | "error"
): void {
  if (tone === "error") {
    Toast.Error(message);
    return;
  }
  Toast.tips(message);
}

export const DESKTOP_AGENT_GUI_EMPTY_CONTEXT_MENTION_PROVIDERS =
  [] satisfies readonly AgentContextMentionProvider[];
export const DESKTOP_AGENT_GUI_EMPTY_PROVIDER_STATUS_SNAPSHOT = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
} satisfies ReturnType<IAgentProviderStatusService["getSnapshot"]>;
export const DESKTOP_AGENT_GUI_POSITION = { x: 0, y: 0 };

export function areDesktopAgentGUIWorkbenchBodyPropsEqual(
  previous: DesktopAgentGUIWorkbenchBodyProps,
  next: DesktopAgentGUIWorkbenchBodyProps
): boolean {
  return (
    previous.agentActivityRuntime === next.agentActivityRuntime &&
    previous.agentHostApi === next.agentHostApi &&
    previous.appCenterService === next.appCenterService &&
    previous.agentProviderStatusService === next.agentProviderStatusService &&
    previous.computerUseApi === next.computerUseApi &&
    previous.composerAppendRequest === next.composerAppendRequest &&
    previous.conversationRailAutoCollapseWidthPx ===
      next.conversationRailAutoCollapseWidthPx &&
    previous.dockPreviewCache === next.dockPreviewCache &&
    previous.onLinkAction === next.onLinkAction &&
    previous.onCapabilitySettingsRequest === next.onCapabilitySettingsRequest &&
    previous.onOpenAgentConversationWindow ===
      next.onOpenAgentConversationWindow &&
    previous.prefillPromptBootstrapRequest ===
      next.prefillPromptBootstrapRequest &&
    previous.previewMode === next.previewMode &&
    previous.providerStatusBootstrapSnapshot ===
      next.providerStatusBootstrapSnapshot &&
    previous.agentDirectory === next.agentDirectory &&
    previous.allAgentsPresentation?.iconUrl ===
      next.allAgentsPresentation?.iconUrl &&
    previous.renderAgentsEmpty === next.renderAgentsEmpty &&
    previous.comingSoonAgentProviders === next.comingSoonAgentProviders &&
    previous.defaultAgentTargetId === next.defaultAgentTargetId &&
    previous.contextMentionProviders === next.contextMentionProviders &&
    previous.runtimeApi === next.runtimeApi &&
    previous.trackAgentProviderChatReady === next.trackAgentProviderChatReady &&
    previous.onEngagementEvent === next.onEngagementEvent &&
    previous.trackWorkspaceFileReferences ===
      next.trackWorkspaceFileReferences &&
    previous.workspaceFileReferenceAdapter ===
      next.workspaceFileReferenceAdapter &&
    previous.resolveExternalPromptEntries ===
      next.resolveExternalPromptEntries &&
    previous.prepareExternalPromptFiles === next.prepareExternalPromptFiles &&
    previous.onRequestGitBranches === next.onRequestGitBranches &&
    previous.referenceSourceAggregator === next.referenceSourceAggregator &&
    previous.renderSidebarFooter === next.renderSidebarFooter &&
    previous.resolveWorkspaceReferenceEntryIconUrl ===
      next.resolveWorkspaceReferenceEntryIconUrl &&
    previous.resolveMentionReferenceTarget ===
      next.resolveMentionReferenceTarget &&
    previous.resolveWorkspaceReferenceInitialTarget ===
      next.resolveWorkspaceReferenceInitialTarget &&
    previous.workspaceId === next.workspaceId &&
    areDesktopAgentGUIWorkbenchBodyContextsEqual(previous.context, next.context)
  );
}

export function areDesktopAgentGUIWorkbenchBodyContextsEqual(
  previous: WorkbenchHostNodeBodyContext,
  next: WorkbenchHostNodeBodyContext
): boolean {
  return (
    previous === next ||
    (previous.activation === next.activation &&
      previous.displayMode === next.displayMode &&
      previous.externalNodeState === next.externalNodeState &&
      previous.host === next.host &&
      previous.instanceId === next.instanceId &&
      previous.instanceKey === next.instanceKey &&
      previous.isDragging === next.isDragging &&
      previous.isFocused === next.isFocused &&
      previous.isResizing === next.isResizing &&
      previous.presentationMode === next.presentationMode &&
      previous.node.id === next.node.id &&
      previous.node.isMinimized === next.node.isMinimized &&
      previous.node.title === next.node.title &&
      areDesktopAgentGUIWorkbenchFramesEqual(previous, next) &&
      previous.node.data.runtimeNodeState === next.node.data.runtimeNodeState)
  );
}

function areDesktopAgentGUIWorkbenchFramesEqual(
  previous: WorkbenchHostNodeBodyContext,
  next: WorkbenchHostNodeBodyContext
): boolean {
  if (next.isDragging || next.isResizing) {
    return true;
  }
  return (
    previous.node.frame.width === next.node.frame.width &&
    previous.node.frame.height === next.node.frame.height &&
    previous.node.frame.x === next.node.frame.x &&
    previous.node.frame.y === next.node.frame.y
  );
}

export function getEmptyProviderStatusSnapshot(): ReturnType<
  IAgentProviderStatusService["getSnapshot"]
> {
  return DESKTOP_AGENT_GUI_EMPTY_PROVIDER_STATUS_SNAPSHOT;
}

export function noopSubscribe(): () => void {
  return () => {};
}

export const AUTH_FAILURE_MARKERS = [
  "authentication_failed",
  "invalid authentication credentials",
  "401 invalid authentication",
  "unauthorized",
  "not logged in",
  "please run /login",
  "invalid api key"
];

// Read defensively: session events arrive as `unknown`, in either the
// {eventType:"message_update", data:{status,payload}} runtime shape or a flatter
// {status,payload,content} shape. We only care about a failed turn whose payload
// looks like an authentication failure (matching the daemon's classification).
export function sessionEventLooksLikeAuthFailure(event: unknown): boolean {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const record = event as {
    status?: unknown;
    content?: unknown;
    payload?: Record<string, unknown>;
    data?: { status?: unknown; payload?: Record<string, unknown> };
  };
  const status = record.data?.status ?? record.status;
  if (status !== "failed") {
    return false;
  }
  const payload = record.data?.payload ?? record.payload ?? {};
  if (payload["code"] === "auth_required") {
    return true;
  }
  const text = [
    payload["content"],
    payload["text"],
    payload["detail"],
    record.content
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return AUTH_FAILURE_MARKERS.some((marker) => text.includes(marker));
}
