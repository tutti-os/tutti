import type { ReactNode } from "react";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import type {
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReference,
  ReferenceProvenanceCatalog
} from "@tutti-os/workspace-file-reference/contracts";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import type { ReferenceSourcePickerProps } from "@tutti-os/workspace-file-reference/ui";
import type { AgentGuiWorkbenchSessionActionRequest } from "../../workbench/sessionActions";
import type { AgentSettings } from "../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type {
  AgentGUINodeData,
  AgentGUIProvider,
  AgentGUIProviderRailAllPresentation,
  AgentGUIProviderRailMode,
  AgentGUIProviderReadinessGate,
  AgentGUITargetConnectionSource,
  AgentGUIHomeSuggestionId,
  AgentGUIAgentTarget,
  NodeFrame,
  Point
} from "../../types";
import type { DesktopSize } from "../workspaceDesktop/types";
import type {
  AgentGUIOpenSessionRequest,
  AgentGUIPrefillPromptRequest,
  AgentGUIRememberComposerDefaultsInput,
  AgentGUIRememberComposerDefaultsResult
} from "./controller/useAgentGUINodeController";
import type { AgentStatusController } from "./controller/AgentStatusController";
import type {
  AgentGUISidebarFooterContext,
  AgentGUIConversationRailLayout,
  AgentGUIAgentsEmptyRenderer,
  AgentGUIProviderUnavailableStateRenderer,
  AgentMentionReferenceTargetResolver,
  AgentWorkspaceReferenceInitialTargetResolver
} from "./AgentGUINodeView";
import type { AgentVisibleErrorOverrides } from "../../shared/agentEnv/agentErrorPresentation";
import type {
  AgentComposerCapabilityMenuState,
  AgentComposerCapabilitySettingsTarget,
  AgentComposerGitBranchLoader,
  AgentComposerProps
} from "./AgentComposer";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../shared/AgentMessageMarkdown";
import type { RichTextMentionService } from "@tutti-os/ui-rich-text/service";
import type { AgentGUIEngagementEventSink } from "./engagement/agentGUIEngagement.types";
import type { AgentGUIComposerAppendRequest } from "./controller/useAgentGUIComposerAppendRequest";
import type { OpenAgentEnvPanelInput } from "../../shared/agentEnv";

export interface AgentGUINodeIdentity {
  nodeId: string;
  workspaceId: string;
  currentUserId?: string | null;
  title: string;
}

export interface AgentGUINodeWorkspace {
  path: string;
  fileReferenceAdapter?: WorkspaceFileReferenceAdapter | null;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  resolveExternalPromptEntries?: AgentComposerProps["resolveExternalPromptEntries"];
  prepareExternalPromptFiles?: AgentComposerProps["prepareExternalPromptFiles"];
  promptAssetLimit?: number | null;
  projectDirectorySourceAggregator?: ReferenceSourceAggregator | null;
  referenceSourceAggregator?: ReferenceSourceAggregator | null;
  resolveReferenceContentErrorAction?: ReferenceSourcePickerProps["resolveContentErrorAction"];
  resolveReferenceEntryIconUrl?: (
    entry: WorkspaceFileEntry
  ) => Promise<string | null | undefined>;
  resolveMentionReferenceTarget?: AgentMentionReferenceTargetResolver | null;
  resolveReferenceInitialTarget?: AgentWorkspaceReferenceInitialTargetResolver | null;
  onFileReferencesAdded?: (input: {
    provider: AgentGUIProvider;
    references: readonly WorkspaceFileReference[];
  }) => void | Promise<void>;
  agentSettings: Pick<AgentSettings, "avoidGroupingEdits">;
}

export interface AgentGUINodeFrameLayout {
  position: Point;
  width: number;
  height: number;
  desktopSize: DesktopSize;
  isMaximized?: boolean;
  isActive: boolean;
  /** Host-projected presentation visibility. Independent from node focus. */
  isVisible?: boolean;
  embedded?: boolean;
  conversationRailAutoCollapseWidthPx?: number | null;
}

export type AgentGUISessionActionRequest =
  AgentGuiWorkbenchSessionActionRequest;

export interface AgentGUINodeRuntimeRequests {
  composerAppend?: AgentGUIComposerAppendRequest | null;
  composerFocusSequence?: number | null;
  newConversationSequence?: number | null;
  sessionAction?: AgentGUISessionActionRequest | null;
  openSession?: AgentGUIOpenSessionRequest | null;
  prefillPrompt?: AgentGUIPrefillPromptRequest | null;
  /** On-demand status capability. Transport and owner resolution stay host-owned. */
  agentStatusController?: AgentStatusController | null;
}

export interface AgentGUINodeHostCapabilities {
  /**
   * Complete host-owned catalog for reference provenance filtering. Supplying
   * it explicitly opts the host into the dimensions declared by the catalog.
   * Omit it to keep filtering disabled unless the legacy Agent-only flag is
   * enabled.
   */
  referenceProvenanceFilterCatalog?: ReferenceProvenanceCatalog | null;
  /** Legacy Tutti Agent-only opt-in. Prefer an explicit catalog in new hosts. */
  referenceProvenanceFilterEnabled?: boolean;
  capabilityMenuState?: AgentComposerCapabilityMenuState;
  /**
   * Keeps owner-supported Browser/Computer capability entries visible while
   * preventing this host from mutating device-owned capability settings.
   */
  capabilityControlsReadOnly?: boolean;
  /**
   * Host-owned product copy and external action for structured run errors.
   * AgentGUI owns the generic card; product domains own product semantics.
   */
  visibleErrorPresentationOverrides?: AgentVisibleErrorOverrides | null;
  agentTargets?: readonly AgentGUIAgentTarget[];
  agentTargetsLoading?: boolean;
  /** Launch-only targets for active-conversation handoff. */
  handoffAgentTargets?: readonly AgentGUIAgentTarget[];
  handoffAgentTargetsLoading?: boolean;
  providerRailAllPresentation?: AgentGUIProviderRailAllPresentation | null;
  providerRailMode?: AgentGUIProviderRailMode;
  comingSoonProviders?: readonly AgentGUIProvider[];
  providerReadinessGates?: Partial<
    Record<AgentGUIProvider, AgentGUIProviderReadinessGate | null>
  > | null;
  targetConnectionSource?: AgentGUITargetConnectionSource | null;
  defaultAgentTargetId?: string | null;
  providerAuthAccountLabels?: Partial<Record<string, string>>;
  mentionService?: RichTextMentionService;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  disabledHomeSuggestions?: readonly AgentGUIHomeSuggestionId[];
}

export interface AgentGUINodeHostActions {
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onHandoffConversation?: (input: {
    agentTargetId?: string | null;
    draftPrompt: string;
    provider: AgentGUIProvider;
    sourceAgentSessionId: string;
    userProjectPath?: string | null;
  }) => void | Promise<void>;
  onCapabilitySettingsRequest?: (
    capability: AgentComposerCapabilitySettingsTarget
  ) => void;
  onAgentProviderLogin?: (provider: AgentGUIProvider) => void;
  onAgentEnvPanelOpen?: (input?: OpenAgentEnvPanelInput) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onClose: () => void;
  onResize: (frame: NodeFrame) => void;
  onUpdateNode: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onRememberComposerDefaults?: (
    input: AgentGUIRememberComposerDefaultsInput
  ) => void | Promise<AgentGUIRememberComposerDefaultsResult>;
  isMuted?: boolean;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onShowMessage?: (
    message: string,
    tone?: "info" | "warning" | "error"
  ) => void;
  onEngagementEvent?: AgentGUIEngagementEventSink;
  /**
   * Reports live left-side rail layout width while the conversation rail is
   * being resized. Hosts with external chrome aligned to the rail can consume
   * this instead of observing package DOM/style mutations.
   */
  onConversationRailLayoutChange?: (
    layout: AgentGUIConversationRailLayout
  ) => void;
}

export interface AgentGUINodeRenderSlots {
  providerRailEmpty?: AgentGUIAgentsEmptyRenderer;
  providerUnavailableState?: AgentGUIProviderUnavailableStateRenderer;
  sidebarFooter?: (ctx: AgentGUISidebarFooterContext) => ReactNode;
}

export interface AgentGUINodeProps {
  identity: AgentGUINodeIdentity;
  workspace: AgentGUINodeWorkspace;
  frame: AgentGUINodeFrameLayout;
  state: AgentGUINodeData;
  runtimeRequests: AgentGUINodeRuntimeRequests;
  hostCapabilities: AgentGUINodeHostCapabilities;
  hostActions: AgentGUINodeHostActions;
  renderSlots: AgentGUINodeRenderSlots;
}

function agentGuiStateEquals(
  left: AgentGUINodeData,
  right: AgentGUINodeData
): boolean {
  return (
    left === right ||
    (left.provider === right.provider &&
      (left.agentTargetId ?? null) === (right.agentTargetId ?? null) &&
      left.lastActiveAgentSessionId === right.lastActiveAgentSessionId &&
      stringRecordsEqual(
        left.lastActiveAgentSessionIdByAgentTargetId,
        right.lastActiveAgentSessionIdByAgentTargetId
      ) &&
      left.conversationRailWidthPx === right.conversationRailWidthPx &&
      left.conversationRailCollapsed === right.conversationRailCollapsed &&
      (left.composerOverrides?.model ?? null) ===
        (right.composerOverrides?.model ?? null) &&
      (left.composerOverrides?.reasoningEffort ?? null) ===
        (right.composerOverrides?.reasoningEffort ?? null) &&
      (left.composerOverrides?.planMode ?? null) ===
        (right.composerOverrides?.planMode ?? null) &&
      (left.composerOverrides?.permissionModeId ?? null) ===
        (right.composerOverrides?.permissionModeId ?? null) &&
      composerOverridesByProviderEqual(
        left.composerOverridesByProvider,
        right.composerOverridesByProvider
      ) &&
      composerOverridesByAgentTargetIdEqual(
        left.composerOverridesByAgentTargetId,
        right.composerOverridesByAgentTargetId
      ))
  );
}

function composerOverridesByProviderEqual(
  left: AgentGUINodeData["composerOverridesByProvider"],
  right: AgentGUINodeData["composerOverridesByProvider"]
): boolean {
  const providers = new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {})
  ]);
  for (const provider of providers) {
    const key = provider as keyof NonNullable<
      AgentGUINodeData["composerOverridesByProvider"]
    >;
    const leftSettings = left?.[key] ?? null;
    const rightSettings = right?.[key] ?? null;
    if (
      (leftSettings?.model ?? null) !== (rightSettings?.model ?? null) ||
      (leftSettings?.reasoningEffort ?? null) !==
        (rightSettings?.reasoningEffort ?? null) ||
      (leftSettings?.planMode ?? null) !== (rightSettings?.planMode ?? null) ||
      (leftSettings?.permissionModeId ?? null) !==
        (rightSettings?.permissionModeId ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function composerOverridesByAgentTargetIdEqual(
  left: AgentGUINodeData["composerOverridesByAgentTargetId"],
  right: AgentGUINodeData["composerOverridesByAgentTargetId"]
): boolean {
  const keys = new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {})
  ]);
  for (const key of keys) {
    const leftSettings = left?.[key] ?? null;
    const rightSettings = right?.[key] ?? null;
    if (
      (leftSettings?.model ?? null) !== (rightSettings?.model ?? null) ||
      (leftSettings?.reasoningEffort ?? null) !==
        (rightSettings?.reasoningEffort ?? null) ||
      (leftSettings?.planMode ?? null) !== (rightSettings?.planMode ?? null) ||
      (leftSettings?.permissionModeId ?? null) !==
        (rightSettings?.permissionModeId ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function stringRecordsEqual(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): boolean {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left?.[key] === right?.[key]
    )
  );
}

export function areAgentGUINodePropsEqual(
  previous: AgentGUINodeProps,
  next: AgentGUINodeProps
): boolean {
  const pi = previous.identity,
    ni = next.identity;
  const pw = previous.workspace,
    nw = next.workspace;
  const pf = previous.frame,
    nf = next.frame;
  const pr = previous.runtimeRequests,
    nr = next.runtimeRequests;
  const pc = previous.hostCapabilities,
    nc = next.hostCapabilities;
  const pa = previous.hostActions,
    na = next.hostActions;
  const ps = previous.renderSlots,
    ns = next.renderSlots;
  return (
    pi.nodeId === ni.nodeId &&
    pi.workspaceId === ni.workspaceId &&
    pi.currentUserId === ni.currentUserId &&
    pi.title === ni.title &&
    pw.path === nw.path &&
    pw.fileReferenceAdapter === nw.fileReferenceAdapter &&
    pw.onRequestGitBranches === nw.onRequestGitBranches &&
    pw.selectProjectDirectory === nw.selectProjectDirectory &&
    pw.resolveExternalPromptEntries === nw.resolveExternalPromptEntries &&
    pw.prepareExternalPromptFiles === nw.prepareExternalPromptFiles &&
    pw.promptAssetLimit === nw.promptAssetLimit &&
    pw.projectDirectorySourceAggregator ===
      nw.projectDirectorySourceAggregator &&
    pw.referenceSourceAggregator === nw.referenceSourceAggregator &&
    pw.resolveReferenceContentErrorAction ===
      nw.resolveReferenceContentErrorAction &&
    pw.resolveReferenceEntryIconUrl === nw.resolveReferenceEntryIconUrl &&
    pw.resolveMentionReferenceTarget === nw.resolveMentionReferenceTarget &&
    pw.resolveReferenceInitialTarget === nw.resolveReferenceInitialTarget &&
    pw.onFileReferencesAdded === nw.onFileReferencesAdded &&
    pw.agentSettings.avoidGroupingEdits ===
      nw.agentSettings.avoidGroupingEdits &&
    pc.referenceProvenanceFilterCatalog ===
      nc.referenceProvenanceFilterCatalog &&
    pc.referenceProvenanceFilterEnabled ===
      nc.referenceProvenanceFilterEnabled &&
    agentGuiStateEquals(previous.state, next.state) &&
    pf.position.x === nf.position.x &&
    pf.position.y === nf.position.y &&
    pf.width === nf.width &&
    pf.height === nf.height &&
    pf.desktopSize.width === nf.desktopSize.width &&
    pf.desktopSize.height === nf.desktopSize.height &&
    pf.isMaximized === nf.isMaximized &&
    pf.isActive === nf.isActive &&
    pf.isVisible === nf.isVisible &&
    pf.embedded === nf.embedded &&
    pf.conversationRailAutoCollapseWidthPx ===
      nf.conversationRailAutoCollapseWidthPx &&
    pr.composerFocusSequence === nr.composerFocusSequence &&
    pr.composerAppend === nr.composerAppend &&
    pr.newConversationSequence === nr.newConversationSequence &&
    pr.sessionAction === nr.sessionAction &&
    pr.openSession === nr.openSession &&
    pr.prefillPrompt === nr.prefillPrompt &&
    pr.agentStatusController === nr.agentStatusController &&
    pc.capabilityMenuState === nc.capabilityMenuState &&
    pc.capabilityControlsReadOnly === nc.capabilityControlsReadOnly &&
    pc.agentTargets === nc.agentTargets &&
    pc.agentTargetsLoading === nc.agentTargetsLoading &&
    pc.handoffAgentTargets === nc.handoffAgentTargets &&
    pc.handoffAgentTargetsLoading === nc.handoffAgentTargetsLoading &&
    pc.providerRailAllPresentation?.iconUrl ===
      nc.providerRailAllPresentation?.iconUrl &&
    pc.providerRailMode === nc.providerRailMode &&
    pc.comingSoonProviders === nc.comingSoonProviders &&
    pc.providerReadinessGates === nc.providerReadinessGates &&
    pc.targetConnectionSource === nc.targetConnectionSource &&
    pc.defaultAgentTargetId === nc.defaultAgentTargetId &&
    pc.providerAuthAccountLabels === nc.providerAuthAccountLabels &&
    pc.mentionService === nc.mentionService &&
    pc.workspaceAppIcons === nc.workspaceAppIcons &&
    pc.disabledHomeSuggestions === nc.disabledHomeSuggestions &&
    pa.onLinkAction === na.onLinkAction &&
    pa.onHandoffConversation === na.onHandoffConversation &&
    pa.onCapabilitySettingsRequest === na.onCapabilitySettingsRequest &&
    pa.onAgentProviderLogin === na.onAgentProviderLogin &&
    pa.onAgentEnvPanelOpen === na.onAgentEnvPanelOpen &&
    pa.onOpenConversationWindow === na.onOpenConversationWindow &&
    pa.onClose === na.onClose &&
    pa.onResize === na.onResize &&
    pa.onUpdateNode === na.onUpdateNode &&
    pa.onRememberComposerDefaults === na.onRememberComposerDefaults &&
    pa.isMuted === na.isMuted &&
    pa.onMinimize === na.onMinimize &&
    pa.onToggleMaximize === na.onToggleMaximize &&
    pa.onShowMessage === na.onShowMessage &&
    pa.onEngagementEvent === na.onEngagementEvent &&
    pa.onConversationRailLayoutChange === na.onConversationRailLayoutChange &&
    ps.providerRailEmpty === ns.providerRailEmpty &&
    ps.providerUnavailableState === ns.providerUnavailableState &&
    ps.sidebarFooter === ns.sidebarFooter
  );
}
