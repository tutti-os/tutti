import { memo, useCallback, useEffect, useMemo } from "react";
import { createWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { createWorkspaceFileManagerI18nRuntime } from "@tutti-os/workspace-file-manager";
import { useTranslation, type TranslateFn } from "../../i18n/index";
import { toLocalShortDateTime } from "../../app/renderer/shell/utils/format";
import type {
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";
import type {
  AgentHostManagedAgentsState,
  AgentUsageQuota
} from "../../shared/contracts/dto";
import type {
  AgentProvider,
  AgentSettings
} from "../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type {
  AgentGUINodeData,
  AgentGUIProviderTarget,
  NodeFrame,
  Point
} from "../../types";
import { agentGUIProviderTargetRefsEqual } from "../../providerTargets";
import type {
  DesktopSize,
  WorkspaceDesktopAgentProbeDemandChange,
  WorkspaceDesktopAgentProbesState
} from "../workspaceDesktop/types";
import { resolveCanonicalNodeMinSize } from "../../utils/workspaceNodeSizing";
import { WorkspaceNodeWindow } from "../shared/WorkspaceNodeWindow";
import { CanvasNodeGhostIconButton } from "../shared/CanvasNodeGhostIconButton";
import { CanvasNodePanelLinedIcon } from "../shared/canvasNodeChromeIcons";
import { useAgentGUINodeController } from "./controller/useAgentGUINodeController";
import type {
  AgentGUIOpenSessionRequest,
  AgentGUIPrefillPromptRequest,
  AgentGUIRememberComposerDefaultsInput
} from "./controller/useAgentGUINodeController";
import {
  AgentGUINodeView,
  type AgentGUIViewLabels,
  type AgentMentionReferenceTargetResolver,
  type AgentWorkspaceReferenceInitialTargetResolver
} from "./AgentGUINodeView";
import {
  normalizeAgentGUIProviderIdentity,
  resolveAgentGUIConversationDisplayTitle,
  resolveAgentGUIDockConversationTitle,
  resolveAgentGUIProviderDisplayLabel
} from "./model/agentGuiProviderIdentity";
import { formatAgentSessionMentionText } from "../../shared/utils/agentSessionMentionText";
import {
  buildDockAgentProbeTooltipLines,
  findWorkspaceAgentProbeForDockProvider,
  workspaceAgentProbeRenderStateEqualsForProvider
} from "../workspaceDesktop/view/desktopDockAgentProbeTooltipModel";
import { AgentProbeInfoPopover } from "../workspaceDesktop/view/AgentProbeInfoPopover";
import {
  getAgentHostManagedToolchainAgentByName,
  resolveAgentHostManagedToolchainAgentAction
} from "../../shared/utils/managedToolchainAgents";
import styles from "./AgentGUINode.styles";
import {
  AGENT_GUI_COLLAPSED_MIN_WIDTH_PX,
  AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX,
  AGENT_GUI_DETAIL_MIN_WIDTH_PX,
  clampAgentGUIConversationRailWidthPx,
  resolveAgentGUIExpandedWindowFrame,
  resolveNextAgentGUIConversationRailWidthPx,
  resolveAgentGUIConversationRailMaxWidthPx,
  shouldAutoCollapseAgentGUIConversationRail
} from "./model/agentGuiRailLayout";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../shared/AgentMessageMarkdown";
import type {
  AgentComposerCapabilityMenuState,
  AgentComposerCapabilitySettingsTarget,
  AgentComposerGitBranchLoader,
  AgentComposerSlashStatusLimit
} from "./AgentComposer";
import { agentGuiDockIconUrls } from "../../dockIcons";

const workspaceFileReferenceLocaleKeyByPickerKey: Record<string, string> = {
  "actions.cancel": "common.cancel",
  "referencePicker.confirm": "agentHost.agentGui.referencePicker.confirm",
  "referencePicker.clearFilter":
    "agentHost.agentGui.referencePicker.clearFilter",
  "referencePicker.emptyDirectory":
    "agentHost.agentGui.referencePicker.emptyDirectory",
  "referencePicker.emptyPreview":
    "agentHost.agentGui.referencePicker.emptyPreview",
  "referencePicker.emptySearch":
    "agentHost.agentGui.referencePicker.emptySearch",
  "referencePicker.fileTypeAll":
    "agentHost.agentGui.referencePicker.fileTypeAll",
  "referencePicker.fileTypeDocument":
    "agentHost.agentGui.referencePicker.fileTypeDocument",
  "referencePicker.fileTypeImage":
    "agentHost.agentGui.referencePicker.fileTypeImage",
  "referencePicker.fileTypeOther":
    "agentHost.agentGui.referencePicker.fileTypeOther",
  "referencePicker.fileTypeSeparator":
    "agentHost.agentGui.referencePicker.fileTypeSeparator",
  "referencePicker.fileTypeVideo":
    "agentHost.agentGui.referencePicker.fileTypeVideo",
  "referencePicker.fileTypeWebpage":
    "agentHost.agentGui.referencePicker.fileTypeWebpage",
  "referencePicker.loadMore": "agentHost.agentGui.referencePicker.loadMore",
  "referencePicker.loadMoreGroups":
    "agentHost.agentGui.referencePicker.loadMoreGroups",
  "referencePicker.loading": "agentHost.agentGui.referencePicker.loading",
  "referencePicker.previewBinary":
    "agentHost.agentGui.referencePicker.previewBinary",
  "referencePicker.previewDecodeFailed":
    "agentHost.agentGui.referencePicker.previewDecodeFailed",
  "referencePicker.previewError":
    "agentHost.agentGui.referencePicker.previewError",
  "referencePicker.previewFileTooLarge":
    "agentHost.agentGui.referencePicker.previewFileTooLarge",
  "referencePicker.previewFolder":
    "agentHost.agentGui.referencePicker.previewFolder",
  "referencePicker.previewHierarchy":
    "agentHost.agentGui.referencePicker.previewHierarchy",
  "referencePicker.previewLoading":
    "agentHost.agentGui.referencePicker.previewLoading",
  "referencePicker.previewModified":
    "agentHost.agentGui.referencePicker.previewModified",
  "referencePicker.previewSize":
    "agentHost.agentGui.referencePicker.previewSize",
  "referencePicker.previewSource":
    "agentHost.agentGui.referencePicker.previewSource",
  "referencePicker.previewTextTooLarge":
    "agentHost.agentGui.referencePicker.previewTextTooLarge",
  "referencePicker.previewTooLarge":
    "agentHost.agentGui.referencePicker.previewTooLarge",
  "referencePicker.previewUnavailable":
    "agentHost.agentGui.referencePicker.previewUnavailable",
  "referencePicker.previewUnsupported":
    "agentHost.agentGui.referencePicker.previewUnsupported",
  "referencePicker.searchPlaceholder":
    "agentHost.agentGui.referencePicker.searchPlaceholder",
  "referencePicker.selectGroupHint":
    "agentHost.agentGui.referencePicker.selectGroupHint",
  "referencePicker.selectedCount":
    "agentHost.agentGui.referencePicker.selectedCount",
  "referencePicker.workspaceRootGroup":
    "agentHost.agentGui.referencePicker.workspaceRootGroup",
  "referencePicker.sourceColumn":
    "agentHost.agentGui.referencePicker.sourceColumn",
  "referencePicker.title": "agentHost.agentGui.referencePicker.title"
};

export interface AgentGUINodeProps {
  nodeId: string;
  workspaceId: string;
  currentUserId?: string | null;
  workspacePath: string;
  workspaceFileReferenceAdapter?: WorkspaceFileReferenceAdapter | null;
  onRequestGitBranches?: AgentComposerGitBranchLoader | null;
  selectProjectDirectory?: () => Promise<{ path: string } | null>;
  referenceSourceAggregator?: ReferenceSourceAggregator | null;
  resolveMentionReferenceTarget?: AgentMentionReferenceTargetResolver | null;
  resolveWorkspaceReferenceInitialTarget?: AgentWorkspaceReferenceInitialTargetResolver | null;
  agentSettings: Pick<AgentSettings, "avoidGroupingEdits">;
  title: string;
  state: AgentGUINodeData;
  position: Point;
  width: number;
  height: number;
  desktopSize: DesktopSize;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  capabilityMenuState?: AgentComposerCapabilityMenuState;
  onCapabilitySettingsRequest?: (
    capability: AgentComposerCapabilitySettingsTarget
  ) => void;
  onAgentProviderLogin?: (provider: AgentProvider) => void;
  providerTargets?: readonly AgentGUIProviderTarget[];
  defaultProviderTargetId?: string | null;
  onWorkspaceFileReferencesAdded?: (input: {
    provider: AgentProvider;
    references: readonly WorkspaceFileReference[];
  }) => void | Promise<void>;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onClose: () => void;
  onResize: (frame: NodeFrame) => void;
  onUpdateNode: (
    updater: (current: AgentGUINodeData) => AgentGUINodeData
  ) => void;
  onRememberComposerDefaults?: (
    input: AgentGUIRememberComposerDefaultsInput
  ) => void | Promise<void>;
  isMaximized?: boolean;
  isActive: boolean;
  composerFocusRequestSequence?: number | null;
  openSessionRequest?: AgentGUIOpenSessionRequest | null;
  prefillPromptRequest?: AgentGUIPrefillPromptRequest | null;
  isMuted?: boolean;
  newConversationRequestSequence?: number | null;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onShowMessage?: (
    message: string,
    tone?: "info" | "warning" | "error"
  ) => void;
  workspaceAgentProbes?: WorkspaceDesktopAgentProbesState | null;
  onAgentProbeDemandChange?: WorkspaceDesktopAgentProbeDemandChange;
  managedAgentsState?: AgentHostManagedAgentsState | null;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
  embedded?: boolean;
  previewMode?: boolean;
}

function slashStatusQuotaLabel(quota: AgentUsageQuota, t: TranslateFn): string {
  const modelName = quota.modelName?.trim();
  if (modelName) {
    return modelName;
  }
  switch (quota.quotaType) {
    case "session":
      return t("agentHost.agentGui.slashStatusFiveHourLimit");
    case "weekly":
      return t("agentHost.agentGui.slashStatusWeeklyLimit");
    case "daily":
      return t("agentHost.workspaceAgentProbeQuotaDaily");
    case "monthly":
      return t("agentHost.workspaceAgentProbeQuotaMonthly");
    case "cost":
      return t("agentHost.workspaceAgentProbeQuotaCost");
    case "model":
      return t("agentHost.workspaceAgentProbeAgentUsage");
    default:
      return quota.quotaType;
  }
}

function slashStatusQuotaValue(quota: AgentUsageQuota, t: TranslateFn): string {
  if (
    typeof quota.percentRemaining === "number" &&
    Number.isFinite(quota.percentRemaining)
  ) {
    return t("agentHost.agentGui.slashStatusLimitPercentLeft", {
      percent: Math.round(quota.percentRemaining)
    });
  }
  if (
    typeof quota.dollarRemaining === "number" &&
    Number.isFinite(quota.dollarRemaining)
  ) {
    return t("agentHost.workspaceAgentProbeQuotaDollarRemaining", {
      amount: quota.dollarRemaining.toFixed(2)
    });
  }
  return "";
}

function slashStatusQuotaReset(quota: AgentUsageQuota, t: TranslateFn): string {
  const reset =
    typeof quota.resetsAtUnixMs === "number" &&
    Number.isFinite(quota.resetsAtUnixMs)
      ? toLocalShortDateTime(quota.resetsAtUnixMs)
      : quota.resetText?.trim();
  return reset ? t("agentHost.agentGui.slashStatusLimitReset", { reset }) : "";
}

function slashStatusLimitsFromQuotas(
  quotas: readonly AgentUsageQuota[] | undefined,
  selectedModel: string | null | undefined,
  t: TranslateFn
): AgentComposerSlashStatusLimit[] {
  const filteredQuotas = filterSlashStatusQuotasForModel(quotas, selectedModel);
  return filteredQuotas
    .map((quota, index): AgentComposerSlashStatusLimit | null => {
      const value = slashStatusQuotaValue(quota, t);
      if (!value) {
        return null;
      }
      const label = slashStatusQuotaLabel(quota, t).trim();
      if (!label) {
        return null;
      }
      return {
        id: `${quota.quotaType}:${quota.modelName ?? ""}:${index}`,
        label,
        percentRemaining:
          typeof quota.percentRemaining === "number" &&
          Number.isFinite(quota.percentRemaining)
            ? Math.max(0, Math.min(100, Math.round(quota.percentRemaining)))
            : null,
        value,
        reset: slashStatusQuotaReset(quota, t) || null
      };
    })
    .filter((limit): limit is AgentComposerSlashStatusLimit => limit !== null);
}

function slashStatusQuotasFromRuntimeUsage(value: unknown): AgentUsageQuota[] {
  const usage = objectRecord(value);
  const quotas = usage?.quotas;
  if (!Array.isArray(quotas)) {
    return [];
  }
  return quotas
    .map((quota): AgentUsageQuota | null => {
      const record = objectRecord(quota);
      const quotaType = agentUsageQuotaTypeValue(record?.quotaType);
      if (!record || !quotaType) {
        return null;
      }
      const normalized: AgentUsageQuota = { quotaType };
      const percentRemaining = numberValue(record.percentRemaining);
      if (percentRemaining !== null) {
        normalized.percentRemaining = percentRemaining;
      }
      const resetsAtUnixMs = numberValue(record.resetsAtUnixMs);
      if (resetsAtUnixMs !== null) {
        normalized.resetsAtUnixMs = resetsAtUnixMs;
      }
      const resetText = stringValue(record.resetText);
      if (resetText) {
        normalized.resetText = resetText;
      }
      const dollarRemaining = numberValue(record.dollarRemaining);
      if (dollarRemaining !== null) {
        normalized.dollarRemaining = dollarRemaining;
      }
      const modelName = stringValue(record.modelName);
      if (modelName) {
        normalized.modelName = modelName;
      }
      return normalized;
    })
    .filter((quota): quota is AgentUsageQuota => quota !== null);
}

function agentUsageQuotaTypeValue(
  value: unknown
): AgentUsageQuota["quotaType"] | null {
  switch (stringValue(value)) {
    case "session":
    case "weekly":
    case "monthly":
    case "daily":
    case "model":
    case "cost":
      return stringValue(value) as AgentUsageQuota["quotaType"];
    default:
      return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function filterSlashStatusQuotasForModel(
  quotas: readonly AgentUsageQuota[] | undefined,
  selectedModel: string | null | undefined
): readonly AgentUsageQuota[] {
  const normalizedSelectedModel = normalizeSlashStatusModelName(selectedModel);
  const baseQuotas = (quotas ?? []).filter(
    (quota) => quota.quotaType !== "model"
  );
  const matchingModelQuotas = (quotas ?? []).filter((quota) => {
    const quotaModelName = normalizeSlashStatusModelName(quota.modelName);
    return (
      quota.quotaType === "model" &&
      quotaModelName !== "" &&
      normalizedSelectedModel !== "" &&
      quotaModelName === normalizedSelectedModel
    );
  });
  return [...baseQuotas, ...matchingModelQuotas];
}

function normalizeSlashStatusModelName(
  value: string | null | undefined
): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") ?? ""
  );
}

function agentGuiStateEquals(
  left: AgentGUINodeData,
  right: AgentGUINodeData
): boolean {
  return (
    left === right ||
    (left.provider === right.provider &&
      (left.providerTargetId ?? null) === (right.providerTargetId ?? null) &&
      agentGUIProviderTargetRefsEqual(
        left.providerTargetRef,
        right.providerTargetRef
      ) &&
      left.lastActiveAgentSessionId === right.lastActiveAgentSessionId &&
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

function areAgentGUINodePropsEqual(
  previous: AgentGUINodeProps,
  next: AgentGUINodeProps
): boolean {
  return (
    previous.nodeId === next.nodeId &&
    previous.workspaceId === next.workspaceId &&
    previous.currentUserId === next.currentUserId &&
    previous.workspacePath === next.workspacePath &&
    previous.workspaceFileReferenceAdapter ===
      next.workspaceFileReferenceAdapter &&
    previous.selectProjectDirectory === next.selectProjectDirectory &&
    previous.referenceSourceAggregator === next.referenceSourceAggregator &&
    previous.resolveMentionReferenceTarget ===
      next.resolveMentionReferenceTarget &&
    previous.resolveWorkspaceReferenceInitialTarget ===
      next.resolveWorkspaceReferenceInitialTarget &&
    previous.onWorkspaceFileReferencesAdded ===
      next.onWorkspaceFileReferencesAdded &&
    previous.agentSettings.avoidGroupingEdits ===
      next.agentSettings.avoidGroupingEdits &&
    previous.title === next.title &&
    agentGuiStateEquals(previous.state, next.state) &&
    previous.position.x === next.position.x &&
    previous.position.y === next.position.y &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.desktopSize.width === next.desktopSize.width &&
    previous.desktopSize.height === next.desktopSize.height &&
    previous.onLinkAction === next.onLinkAction &&
    previous.onCapabilitySettingsRequest === next.onCapabilitySettingsRequest &&
    previous.onAgentProviderLogin === next.onAgentProviderLogin &&
    previous.providerTargets === next.providerTargets &&
    previous.defaultProviderTargetId === next.defaultProviderTargetId &&
    previous.onClose === next.onClose &&
    previous.onResize === next.onResize &&
    previous.onUpdateNode === next.onUpdateNode &&
    previous.onRememberComposerDefaults === next.onRememberComposerDefaults &&
    previous.onOpenConversationWindow === next.onOpenConversationWindow &&
    previous.isMaximized === next.isMaximized &&
    previous.isMuted === next.isMuted &&
    previous.onMinimize === next.onMinimize &&
    previous.onToggleMaximize === next.onToggleMaximize &&
    previous.onShowMessage === next.onShowMessage &&
    workspaceAgentProbeRenderStateEqualsForProvider(
      previous.workspaceAgentProbes,
      next.workspaceAgentProbes,
      previous.state.provider
    ) &&
    previous.onAgentProbeDemandChange === next.onAgentProbeDemandChange &&
    previous.managedAgentsState === next.managedAgentsState &&
    previous.contextMentionProviders === next.contextMentionProviders &&
    previous.workspaceAppIcons === next.workspaceAppIcons &&
    previous.embedded === next.embedded &&
    previous.previewMode === next.previewMode &&
    previous.isActive === next.isActive &&
    previous.composerFocusRequestSequence ===
      next.composerFocusRequestSequence &&
    previous.newConversationRequestSequence ===
      next.newConversationRequestSequence &&
    previous.openSessionRequest === next.openSessionRequest &&
    previous.prefillPromptRequest === next.prefillPromptRequest
  );
}

export const AgentGUINode = memo(function AgentGUINode({
  nodeId,
  workspaceId,
  currentUserId,
  workspacePath,
  workspaceFileReferenceAdapter = null,
  onRequestGitBranches = null,
  selectProjectDirectory,
  referenceSourceAggregator = null,
  resolveMentionReferenceTarget = null,
  resolveWorkspaceReferenceInitialTarget = null,
  agentSettings,
  title,
  state,
  position,
  width,
  height,
  desktopSize,
  onLinkAction,
  capabilityMenuState,
  onCapabilitySettingsRequest,
  onAgentProviderLogin,
  providerTargets,
  defaultProviderTargetId = null,
  onWorkspaceFileReferencesAdded,
  onOpenConversationWindow,
  onClose,
  onResize,
  onUpdateNode,
  onRememberComposerDefaults,
  isMaximized = false,
  isActive,
  composerFocusRequestSequence = null,
  newConversationRequestSequence = null,
  openSessionRequest = null,
  prefillPromptRequest = null,
  isMuted = false,
  onMinimize,
  onToggleMaximize,
  onShowMessage,
  workspaceAgentProbes,
  onAgentProbeDemandChange,
  managedAgentsState,
  contextMentionProviders,
  workspaceAppIcons,
  embedded = false,
  previewMode = false
}: AgentGUINodeProps): React.JSX.Element {
  "use memo";
  const { i18n, locale, t } = useTranslation();
  const workspaceUserProjectI18n = useMemo(
    () => createWorkspaceUserProjectI18nRuntime(i18n),
    [i18n]
  );
  const workspaceFileManagerI18n = useMemo(
    () =>
      typeof i18n?.t === "function"
        ? createWorkspaceFileManagerI18nRuntime(i18n)
        : null,
    [i18n]
  );
  const handleLinkAction = useCallback(
    (action: WorkspaceLinkAction) => {
      onLinkAction?.(
        action.type === "open-agent-session" && !action.provider
          ? { ...action, provider: state.provider }
          : action
      );
    },
    [onLinkAction, state.provider]
  );
  const handleAgentProviderLogin = useCallback(
    (provider?: string | null) => {
      const resolvedProvider = normalizeAgentGUIProviderIdentity(provider);
      onAgentProviderLogin?.(
        resolvedProvider === "unknown" ? state.provider : resolvedProvider
      );
    },
    [onAgentProviderLogin, state.provider]
  );
  const handleWorkspaceFileReferencesAdded = useCallback(
    (references: readonly WorkspaceFileReference[]) => {
      onWorkspaceFileReferencesAdded?.({
        provider: state.provider,
        references
      });
    },
    [onWorkspaceFileReferencesAdded, state.provider]
  );
  const handleDataChange = useCallback(
    (updater: (current: AgentGUINodeData) => AgentGUINodeData) => {
      if (previewMode) {
        return;
      }
      onUpdateNode(updater);
    },
    [onUpdateNode, previewMode]
  );
  const handleConversationRailWidthChanged = useCallback(
    (widthPx: number) => {
      if (previewMode) {
        return;
      }
      onUpdateNode((current) => {
        const nextWidthPx = resolveNextAgentGUIConversationRailWidthPx({
          currentWidthPx: current.conversationRailWidthPx,
          requestedWidthPx: widthPx,
          containerWidthPx: width
        });

        if (current.conversationRailWidthPx === nextWidthPx) {
          return current;
        }
        return {
          ...current,
          conversationRailWidthPx: nextWidthPx
        };
      });
    },
    [onUpdateNode, previewMode, width]
  );
  const isConversationRailManuallyCollapsed =
    state.conversationRailCollapsed === true;
  const isConversationRailAutoCollapsed =
    shouldAutoCollapseAgentGUIConversationRail(width);
  const isConversationRailCollapsed =
    isConversationRailManuallyCollapsed || isConversationRailAutoCollapsed;
  const minSize = useMemo(
    () => ({
      ...resolveCanonicalNodeMinSize("agentGui"),
      width: AGENT_GUI_COLLAPSED_MIN_WIDTH_PX
    }),
    []
  );
  const toggleConversationRailCollapsed = useCallback(() => {
    if (previewMode) {
      return;
    }
    onUpdateNode((current) => ({
      ...current,
      conversationRailCollapsed: current.conversationRailCollapsed !== true
    }));
  }, [onUpdateNode, previewMode]);
  const handleConversationRailToggle = useCallback(() => {
    if (previewMode) {
      return;
    }
    if (!isConversationRailAutoCollapsed) {
      toggleConversationRailCollapsed();
      return;
    }

    onResize(
      resolveAgentGUIExpandedWindowFrame({
        position,
        width,
        height,
        desktopSize,
        conversationRailWidthPx: state.conversationRailWidthPx
      })
    );
    onUpdateNode((current) => {
      if (current.conversationRailCollapsed !== true) {
        return current;
      }
      return {
        ...current,
        conversationRailCollapsed: false
      };
    });
  }, [
    desktopSize,
    height,
    isConversationRailAutoCollapsed,
    onResize,
    onUpdateNode,
    position,
    previewMode,
    state.conversationRailWidthPx,
    toggleConversationRailCollapsed,
    width
  ]);
  const { viewModel, actions } = useAgentGUINodeController({
    nodeId,
    workspaceId,
    currentUserId,
    workspacePath,
    avoidGroupingEdits: agentSettings.avoidGroupingEdits,
    data: state,
    openSessionRequest,
    prefillPromptRequest,
    providerTargets,
    defaultProviderTargetId,
    previewMode,
    onDataChange: handleDataChange,
    onRememberComposerDefaults,
    onShowMessage
  });
  const handleCreateConversation = useCallback(
    (...args: Parameters<typeof actions.createConversation>) => {
      if (!previewMode) {
        onUpdateNode((current) =>
          current.lastActiveAgentSessionId === null &&
          (current.lastActiveConversationTitle ?? null) === null
            ? current
            : {
                ...current,
                lastActiveAgentSessionId: null,
                lastActiveConversationTitle: null
              }
        );
      }
      actions.createConversation(...args);
    },
    [actions, onUpdateNode, previewMode]
  );
  const viewActions = useMemo(
    () => ({
      ...actions,
      createConversation: handleCreateConversation
    }),
    [actions, handleCreateConversation]
  );

  const fallbackAgentTitle = t("sidebar.fallbackAgentLabel");
  const activeProvider =
    viewModel.activeConversation?.provider ?? state.provider;
  const selectedProviderTargetLabel =
    viewModel.selectedProviderTarget?.label ??
    resolveAgentGUIProviderDisplayLabel(state.provider, fallbackAgentTitle);
  const displayProviderLabel = viewModel.activeConversation
    ? resolveAgentGUIProviderDisplayLabel(activeProvider, fallbackAgentTitle)
    : selectedProviderTargetLabel;
  const windowAgentTitle = viewModel.activeConversation
    ? (getAgentHostManagedToolchainAgentByName(activeProvider)?.label ??
      displayProviderLabel)
    : displayProviderLabel;
  const activeConversationDockTitle = viewModel.activeConversation
    ? resolveAgentGUIDockConversationTitle(viewModel.activeConversation)
    : null;
  const activeConversationWindowTitle = viewModel.activeConversation
    ? formatAgentSessionMentionText(
        resolveAgentGUIConversationDisplayTitle(
          viewModel.activeConversation,
          fallbackAgentTitle
        ),
        { language: locale }
      )
    : null;
  const labels = useMemo<AgentGUIViewLabels>(
    () => ({
      initialPlaceholder: t("agentHost.agentGui.initialPlaceholder", {
        provider: displayProviderLabel
      }),
      followupPlaceholder: t("agentHost.agentGui.followupPlaceholder", {
        provider: displayProviderLabel
      }),
      installRequiredPlaceholder: t(
        "agentHost.agentGui.installRequiredPlaceholder",
        {
          provider: displayProviderLabel
        }
      ),
      installRequiredAction: t("agentHost.agentGui.installRequiredAction"),
      collaboratorSessionReadOnlyPlaceholder: t(
        "agentHost.agentGui.collaboratorSessionReadOnlyPlaceholder"
      ),
      send: t("agentHost.agentGui.send"),
      modelLabel: t("agentHost.agentGui.modelLabel"),
      modelSelectionLabel: t("agentHost.agentGui.modelSelectionLabel"),
      modelContextWindowSuffix: t(
        "agentHost.agentGui.modelContextWindowSuffix"
      ),
      modelTooltipVersionLabel: t(
        "agentHost.agentGui.modelTooltipVersionLabel"
      ),
      defaultModel: t("agentHost.agentGui.defaultModel"),
      loadingOptions: t("agentHost.agentGui.loadingOptions"),
      inheritedUnavailable: t("agentHost.agentGui.inheritedUnavailable"),
      reasoningLabel: t("agentHost.agentGui.reasoningLabel"),
      reasoningDegreeLabel: t("agentHost.agentGui.reasoningDegreeLabel"),
      reasoningOptionDefault: t("agentHost.agentGui.reasoningOptionDefault"),
      reasoningOptionMinimal: t("agentHost.agentGui.reasoningOptionMinimal"),
      reasoningOptionLow: t("agentHost.agentGui.reasoningOptionLow"),
      reasoningOptionMedium: t("agentHost.agentGui.reasoningOptionMedium"),
      reasoningOptionHigh: t("agentHost.agentGui.reasoningOptionHigh"),
      reasoningOptionXHigh: t("agentHost.agentGui.reasoningOptionXHigh"),
      reasoningOptionMax: t("agentHost.agentGui.reasoningOptionMax"),
      speedLabel: t("agentHost.agentGui.speedLabel"),
      speedSelectionLabel: t("agentHost.agentGui.speedSelectionLabel"),
      speedOptionStandard: t("agentHost.agentGui.speedOptionStandard"),
      speedOptionStandardDescription: t(
        "agentHost.agentGui.speedOptionStandardDescription"
      ),
      speedOptionFast: t("agentHost.agentGui.speedOptionFast"),
      speedOptionFastDescription: t(
        "agentHost.agentGui.speedOptionFastDescription"
      ),
      permissionLabel: t("agentHost.agentGui.permissionLabel"),
      permissionModeReadOnly: t("agentHost.agentGui.permissionModeReadOnly"),
      permissionModeAuto: t("agentHost.agentGui.permissionModeAuto"),
      permissionModeFullAccess: t(
        "agentHost.agentGui.permissionModeFullAccess"
      ),
      modelDescriptions: {
        frontierComplexCoding: t(
          "agentHost.agentGui.modelDescriptions.frontierComplexCoding"
        ),
        everydayCoding: t(
          "agentHost.agentGui.modelDescriptions.everydayCoding"
        ),
        smallFastCostEfficient: t(
          "agentHost.agentGui.modelDescriptions.smallFastCostEfficient"
        ),
        codingOptimized: t(
          "agentHost.agentGui.modelDescriptions.codingOptimized"
        ),
        ultraFastCoding: t(
          "agentHost.agentGui.modelDescriptions.ultraFastCoding"
        ),
        professionalLongRunning: t(
          "agentHost.agentGui.modelDescriptions.professionalLongRunning"
        )
      },
      planModeLabel: t("agentHost.agentGui.planModeLabel"),
      planModeOnLabel: t("agentHost.agentGui.planModeOnLabel"),
      planModeOffLabel: t("agentHost.agentGui.planModeOffLabel"),
      planUnavailable: t("agentHost.agentGui.planUnavailable"),
      queuedLabel: t("agentHost.agentGui.queuedLabel"),
      sendQueuedPromptNext: t("agentHost.agentGui.sendQueuedPromptNext"),
      editQueuedPrompt: t("agentHost.agentGui.editQueuedPrompt"),
      deleteQueuedPrompt: t("agentHost.agentGui.deleteQueuedPrompt"),
      queuedPromptMoreActions: t("agentHost.agentGui.queuedPromptMoreActions"),
      stop: t("agentHost.agentGui.stop"),
      stopping: t("agentHost.agentGui.stopping"),
      slashStatusTitle: t("agentHost.agentGui.slashStatusTitle"),
      slashStatusSession: t("agentHost.agentGui.slashStatusSession"),
      slashStatusBaseUrl: t("agentHost.agentGui.slashStatusBaseUrl"),
      slashStatusContext: t("agentHost.agentGui.slashStatusContext"),
      slashStatusLimits: t("agentHost.agentGui.slashStatusLimits"),
      slashStatusClose: t("agentHost.agentGui.slashStatusClose"),
      slashStatusContextValue: (input: {
        percentLeft: number;
        usedTokens: string;
        totalTokens: string;
      }) =>
        t("agentHost.agentGui.slashStatusContextValue", {
          percentLeft: input.percentLeft,
          usedTokens: input.usedTokens,
          totalTokens: input.totalTokens
        }),
      slashStatusContextUnavailable: t(
        "agentHost.agentGui.slashStatusContextUnavailable"
      ),
      slashStatusLimitsUnavailable: t(
        "agentHost.agentGui.slashStatusLimitsUnavailable"
      ),
      usageChipLabel: (input: { percent: number }) =>
        t("agentHost.agentGui.usageChipLabel", { percent: input.percent }),
      usageTooltipLabel: t("agentHost.agentGui.usageTooltipLabel"),
      usagePopoverTitle: t("agentHost.agentGui.usagePopoverTitle"),
      usageContextWindowLabel: t("agentHost.agentGui.usageContextWindowLabel"),
      usageTokensLabel: t("agentHost.agentGui.usageTokensLabel"),
      usageLimitsLabel: t("agentHost.agentGui.usageLimitsLabel"),
      usageCompactAction: t("agentHost.agentGui.usageCompactAction"),
      planImplementationLead: t("agentHost.agentGui.planImplementationLead"),
      planImplementationConfirm: t(
        "agentHost.agentGui.planImplementationConfirm"
      ),
      planImplementationFeedbackPlaceholder: t(
        "agentHost.agentGui.planImplementationFeedbackPlaceholder"
      ),
      planImplementationSend: t("agentHost.agentGui.planImplementationSend"),
      planImplementationSkip: t("agentHost.agentGui.planImplementationSkip"),
      noRunningResponse: t("agentHost.agentGui.noRunningResponse"),
      empty: t("agentHost.agentGui.empty", { provider: displayProviderLabel }),
      emptyProvider: displayProviderLabel,
      conversations: t("agentHost.agentGui.conversations"),
      newConversation: t("agentHost.agentGui.newConversation"),
      agentConfig: t("agentHost.agentGui.agentConfig"),
      agentEnvSetup: t("agentHost.agentGui.agentEnvSetup"),
      noConversations: t("agentHost.agentGui.noConversations"),
      emptyProjectConversations: t(
        "agentHost.agentGui.emptyProjectConversations"
      ),
      startConversation: t("agentHost.agentGui.startConversation"),
      selectConversation: t("agentHost.agentGui.selectConversation"),
      loadingConversations: t("agentHost.agentGui.loadingConversations"),
      loadingConversation: t("agentHost.agentGui.loadingConversation"),
      searchNoConversations: t("agentHost.agentGui.searchNoConversations"),
      conversationUnavailable: t("agentHost.agentGui.conversationUnavailable"),
      fallbackAgentTitle,
      searchPlaceholder: t("agentHost.agentGui.searchPlaceholder"),
      sectionPinned: t("agentHost.agentGui.sectionPinned"),
      sectionConversations: t("agentHost.agentGui.sectionConversations"),
      sectionToday: t("agentHost.agentGui.sectionToday"),
      sectionYesterday: t("agentHost.agentGui.sectionYesterday"),
      sectionEarlier: t("agentHost.agentGui.sectionEarlier"),
      projectSectionEdit: t("agentHost.agentGui.projectSectionEdit"),
      projectSectionMoreActions: t(
        "agentHost.agentGui.projectSectionMoreActions"
      ),
      projectSectionViewFiles: t("agentHost.agentGui.projectSectionViewFiles"),
      projectRailCreateProject: t(
        "agentHost.agentGui.projectRailCreateProject"
      ),
      projectRailLinkExistingProject: t(
        "agentHost.agentGui.projectRailLinkExistingProject"
      ),
      removeProject: t("agentHost.agentGui.removeProject"),
      removeProjectConfirmDescription: (projectLabel: string) =>
        t("agentHost.agentGui.removeProjectConfirmDescription", {
          project: projectLabel
        }),
      removeProjectConfirmTitle: t(
        "agentHost.agentGui.removeProjectConfirmTitle"
      ),
      batchDeleteProjectSessions: t(
        "agentHost.agentGui.batchDeleteProjectSessions"
      ),
      batchDeleteProjectSessionsTitle: t(
        "agentHost.agentGui.batchDeleteProjectSessionsTitle"
      ),
      batchDeleteProjectSessionsBody: (count: number, project: string) =>
        t("agentHost.agentGui.batchDeleteProjectSessionsBody", {
          count,
          project
        }),
      batchDeleteProjectSessionsConfirm: t(
        "agentHost.agentGui.batchDeleteProjectSessionsConfirm"
      ),
      approvalRequired: t("agentHost.agentGui.approvalRequired", {
        provider: displayProviderLabel
      }),
      approvalUnavailable: t("agentHost.agentGui.approvalUnavailable"),
      authRequired: t("agentHost.agentGui.authRequired"),
      authLogin: t("agentHost.agentGui.authLogin"),
      activatingSession: t("agentHost.agentGui.activatingSession"),
      cancellingSession: t("agentHost.agentGui.cancellingSession"),
      retryActivation: t("agentHost.agentGui.retryActivation"),
      continueInNewConversation: t(
        "agentHost.agentGui.continueInNewConversation"
      ),
      goalLabel: t("agentHost.agentGui.goalLabel"),
      goalStatusActive: t("agentHost.agentGui.goalStatusActive"),
      goalStatusPaused: t("agentHost.agentGui.goalStatusPaused"),
      goalStatusBlocked: t("agentHost.agentGui.goalStatusBlocked"),
      goalStatusUsageLimited: t("agentHost.agentGui.goalStatusUsageLimited"),
      goalStatusBudgetLimited: t("agentHost.agentGui.goalStatusBudgetLimited"),
      goalStatusComplete: t("agentHost.agentGui.goalStatusComplete"),
      goalBudgetUsage: (used: number, budget: number) =>
        t("agentHost.agentGui.goalBudgetUsage", { used, budget }),
      goalClearHint: t("agentHost.agentGui.goalClearHint"),
      processing: t("agentHost.agentGui.processing"),
      turnSummary: t("agentHost.agentGui.turnSummary"),
      planLead: t("agentHost.agentGui.planLead"),
      planModes: [
        {
          id: "acceptEdits",
          label: t("agentHost.agentGui.planModes.acceptEdits.label"),
          description: t("agentHost.agentGui.planModes.acceptEdits.description")
        },
        {
          id: "default",
          label: t("agentHost.agentGui.planModes.askFirst.label"),
          description: t("agentHost.agentGui.planModes.askFirst.description")
        },
        {
          id: "bypassPermissions",
          label: t("agentHost.agentGui.planModes.allowAll.label"),
          description: t("agentHost.agentGui.planModes.allowAll.description")
        }
      ],
      stayInPlan: t("agentHost.agentGui.stayInPlan"),
      sendFeedback: t("agentHost.agentGui.sendFeedback"),
      feedbackPlaceholder: t("agentHost.agentGui.feedbackPlaceholder"),
      previousQuestion: t("agentHost.agentGui.previousQuestion"),
      nextQuestion: t("agentHost.agentGui.nextQuestion"),
      submitAnswers: t("agentHost.agentGui.submitAnswers"),
      answerPlaceholder: t("agentHost.agentGui.answerPlaceholder"),
      waitingForAnswer: t("agentHost.agentGui.waitingForAnswer"),
      thinkingLabel: t("agentHost.workspaceAgentSessionDetailThinking"),
      toolCallsLabel: (count: number) =>
        t("agentHost.workspaceAgentSessionDetailToolCalls", { count }),
      openConversationWindow: t("agentHost.agentGui.openConversationWindow"),
      showMoreConversations: t("agentHost.agentGui.showMoreConversations"),
      showLessConversations: t("agentHost.agentGui.showLessConversations"),
      deleteSession: t("agentHost.agentGui.deleteSession"),
      pinSession: t("agentHost.agentGui.pinSession"),
      unpinSession: t("agentHost.agentGui.unpinSession"),
      deleteSessionTitle: t("agentHost.agentGui.deleteSessionTitle"),
      deleteSessionBody: t("agentHost.agentGui.deleteSessionBody"),
      deleteSessionConfirm: t("agentHost.agentGui.deleteSessionConfirm"),
      conversationRailResizeAria: t(
        "agentHost.agentGui.conversationRailResizeAria"
      ),
      relativeTimeJustNow: t("agentHost.agentGui.relativeTimeJustNow"),
      relativeTimeMinutes: (count: number) =>
        t("agentHost.agentGui.relativeTimeMinutes", { count }),
      relativeTimeHours: (count: number) =>
        t("agentHost.agentGui.relativeTimeHours", { count }),
      relativeTimeDays: (count: number) =>
        t("agentHost.agentGui.relativeTimeDays", { count }),
      relativeTimeMonths: (count: number) =>
        t("agentHost.agentGui.relativeTimeMonths", { count }),
      relativeTimeYears: (count: number) =>
        t("agentHost.agentGui.relativeTimeYears", { count }),
      syncPending: t("agentHost.agentGui.syncPending"),
      syncSynced: t("agentHost.agentGui.syncSynced"),
      syncFailed: t("agentHost.agentGui.syncFailed"),
      projectLocked: t("agentHost.agentGui.projectLocked"),
      projectMissingDescription: t(
        "agentHost.agentGui.projectMissingDescription"
      ),
      openclawGatewayStarting: t("agentHost.agentGui.openclawGatewayStarting"),
      openclawGatewayFailed: t("agentHost.agentGui.openclawGatewayFailed"),
      openclawGatewayRetry: t("agentHost.agentGui.openclawGatewayRetry"),
      promptTipsPrefix: t("agentHost.agentGui.promptTipsPrefix"),
      reviewPicker: {
        title: t("agentHost.agentGui.reviewPicker.title"),
        targetLabel: t("agentHost.agentGui.reviewPicker.targetLabel"),
        searchPlaceholder: t(
          "agentHost.agentGui.reviewPicker.searchPlaceholder"
        ),
        noResults: t("agentHost.agentGui.reviewPicker.noResults"),
        uncommitted: t("agentHost.agentGui.reviewPicker.uncommitted"),
        baseBranch: t("agentHost.agentGui.reviewPicker.baseBranch"),
        commit: t("agentHost.agentGui.reviewPicker.commit"),
        custom: t("agentHost.agentGui.reviewPicker.custom"),
        branchLabel: t("agentHost.agentGui.reviewPicker.branchLabel"),
        branchPlaceholder: t(
          "agentHost.agentGui.reviewPicker.branchPlaceholder"
        ),
        branchLoading: t("agentHost.agentGui.reviewPicker.branchLoading"),
        branchEmpty: t("agentHost.agentGui.reviewPicker.branchEmpty"),
        commitPlaceholder: t(
          "agentHost.agentGui.reviewPicker.commitPlaceholder"
        ),
        customPlaceholder: t(
          "agentHost.agentGui.reviewPicker.customPlaceholder"
        ),
        submit: t("agentHost.agentGui.reviewPicker.submit"),
        cancel: t("agentHost.agentGui.reviewPicker.cancel")
      },
      promptTips: [
        {
          id: "set-workspace",
          label: t("agentHost.agentGui.promptTips.setWorkspace.label"),
          prompt: t("agentHost.agentGui.promptTips.setWorkspace.prompt")
        },
        {
          id: "use-issue",
          label: t("agentHost.agentGui.promptTips.useIssue.label"),
          prompt: t("agentHost.agentGui.promptTips.useIssue.prompt")
        },
        {
          id: "map-current-state",
          label: t("agentHost.agentGui.promptTips.mapCurrentState.label"),
          prompt: t("agentHost.agentGui.promptTips.mapCurrentState.prompt")
        },
        {
          id: "continue-recent-session",
          label: t("agentHost.agentGui.promptTips.continueRecentSession.label"),
          prompt: t(
            "agentHost.agentGui.promptTips.continueRecentSession.prompt"
          )
        },
        {
          id: "reference-other-agents",
          label: t("agentHost.agentGui.promptTips.referenceOtherAgents.label"),
          prompt: t("agentHost.agentGui.promptTips.referenceOtherAgents.prompt")
        },
        {
          id: "control-permissions",
          label: t("agentHost.agentGui.promptTips.controlPermissions.label"),
          prompt: t("agentHost.agentGui.promptTips.controlPermissions.prompt")
        }
      ],
      cancel: t("common.cancel"),
      slashCommandPalette: t("agentHost.agentGui.slashCommandPalette"),
      skillPickerPalette: t("agentHost.agentGui.skillPickerPalette"),
      slashPaletteCommandsGroup: t(
        "agentHost.agentGui.slashPaletteCommandsGroup"
      ),
      slashPaletteCapabilitiesGroup: t(
        "agentHost.agentGui.slashPaletteCapabilitiesGroup"
      ),
      slashPaletteSkillsGroup: t("agentHost.agentGui.slashPaletteSkillsGroup"),
      slashPalettePluginsGroup: t(
        "agentHost.agentGui.slashPalettePluginsGroup"
      ),
      slashPaletteConnectorsGroup: t(
        "agentHost.agentGui.slashPaletteConnectorsGroup"
      ),
      slashPaletteMcpGroup: t("agentHost.agentGui.slashPaletteMcpGroup"),
      browserUseCapabilityLabel: t(
        "agentHost.agentGui.browserUseCapabilityLabel"
      ),
      browserUseCapabilityDescription: t(
        "agentHost.agentGui.browserUseCapabilityDescription"
      ),
      browserUseCapabilityDescriptionAutoConnect: t(
        "agentHost.agentGui.browserUseCapabilityDescriptionAutoConnect"
      ),
      browserUseCapabilityDescriptionIsolated: t(
        "agentHost.agentGui.browserUseCapabilityDescriptionIsolated"
      ),
      browserUseCapabilitySettingsLabel: t(
        "agentHost.agentGui.browserUseCapabilitySettingsLabel"
      ),
      browserUseCapabilitySettingsDescription: t(
        "agentHost.agentGui.browserUseCapabilitySettingsDescription"
      ),
      capabilityInlineSettingsLabel: t(
        "agentHost.agentGui.capabilityInlineSettingsLabel"
      ),
      computerUseCapabilityLabel: t(
        "agentHost.agentGui.computerUseCapabilityLabel"
      ),
      computerUseCapabilityDescription: t(
        "agentHost.agentGui.computerUseCapabilityDescription"
      ),
      computerUseCapabilitySetupRequiredDescription: t(
        "agentHost.agentGui.computerUseCapabilitySetupRequiredDescription"
      ),
      computerUseCapabilityAuthorizationRequiredDescription: t(
        "agentHost.agentGui.computerUseCapabilityAuthorizationRequiredDescription"
      ),
      computerUseCapabilityAuthorizationUnknownDescription: t(
        "agentHost.agentGui.computerUseCapabilityAuthorizationUnknownDescription"
      ),
      computerUseCapabilitySettingsLabel: t(
        "agentHost.agentGui.computerUseCapabilitySettingsLabel"
      ),
      computerUseCapabilitySettingsDescription: t(
        "agentHost.agentGui.computerUseCapabilitySettingsDescription"
      ),
      fileMentionPalette: t("agentHost.agentGui.fileMentionPalette"),
      fileMentionLoading: t("agentHost.agentGui.fileMentionLoading"),
      fileMentionEmpty: t("agentHost.agentGui.fileMentionEmpty"),
      fileMentionError: t("agentHost.agentGui.fileMentionError"),
      fileMentionTabHint: t("agentHost.agentGui.fileMentionTabHint"),
      removeMention: t("common.remove"),
      addReference: t("agentHost.agentGui.addReference"),
      referenceWorkspaceFiles: t("agentHost.issue.referenceWorkspaceFiles")
    }),
    [displayProviderLabel, fallbackAgentTitle, t]
  );
  const workspaceFileReferenceCopy = useMemo<WorkspaceFileReferenceCopy>(
    () => ({
      t(key, values) {
        const localeKey = workspaceFileReferenceLocaleKeyByPickerKey[key];
        return localeKey ? t(localeKey, values) : key;
      }
    }),
    [t]
  );
  const collapsedWindowConversationTitle = isConversationRailCollapsed
    ? (activeConversationDockTitle ?? state.lastActiveConversationTitle ?? null)
    : null;
  const windowTitle =
    collapsedWindowConversationTitle ||
    (isConversationRailCollapsed ? activeConversationWindowTitle : null) ||
    windowAgentTitle ||
    title;
  const windowTitleIconUrl =
    agentGuiDockIconUrls[activeProvider as keyof typeof agentGuiDockIconUrls] ??
    null;
  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!viewModel.activeConversation) {
      return;
    }
    const nextTitle = activeConversationDockTitle;
    const previousTitle = state.lastActiveConversationTitle ?? null;
    if (
      nextTitle === null &&
      previousTitle !== null &&
      viewModel.activeConversation.id === state.lastActiveAgentSessionId
    ) {
      return;
    }
    if ((state.lastActiveConversationTitle ?? null) === nextTitle) {
      return;
    }
    onUpdateNode((current) => {
      if ((current.lastActiveConversationTitle ?? null) === nextTitle) {
        return current;
      }
      return {
        ...current,
        lastActiveConversationTitle: nextTitle
      };
    });
  }, [
    activeConversationDockTitle,
    onUpdateNode,
    previewMode,
    state.lastActiveAgentSessionId,
    state.lastActiveConversationTitle,
    viewModel.activeConversation
  ]);
  const activeProbeProvider = activeProvider as AgentProvider;
  const activeAgentProbe = useMemo(
    () =>
      findWorkspaceAgentProbeForDockProvider(
        workspaceAgentProbes?.snapshot ?? null,
        activeProbeProvider
      ),
    [activeProbeProvider, workspaceAgentProbes?.snapshot]
  );
  const isActiveAgentProviderReady = useMemo(() => {
    const managedAgent =
      getAgentHostManagedToolchainAgentByName(activeProbeProvider);
    if (!managedAgent) {
      return true;
    }
    if (!managedAgentsState) {
      return true;
    }
    return (
      resolveAgentHostManagedToolchainAgentAction(
        managedAgent,
        managedAgentsState
      ) === "installed"
    );
  }, [activeProbeProvider, managedAgentsState]);
  const runtimeSlashStatusQuotas = useMemo(
    () =>
      slashStatusQuotasFromRuntimeUsage(
        viewModel.sessionChrome.rawState?.runtimeContext?.usage
      ),
    [viewModel.sessionChrome.rawState?.runtimeContext?.usage]
  );
  const slashStatusQuotaSource =
    activeAgentProbe?.usage?.quotas && activeAgentProbe.usage.quotas.length > 0
      ? activeAgentProbe.usage.quotas
      : runtimeSlashStatusQuotas;
  const slashStatusLimits = useMemo(
    () =>
      slashStatusLimitsFromQuotas(
        slashStatusQuotaSource,
        viewModel.composerSettings.selectedModelValue ??
          viewModel.composerSettings.draftSettings.model,
        t
      ),
    [
      slashStatusQuotaSource,
      t,
      viewModel.composerSettings.draftSettings.model,
      viewModel.composerSettings.selectedModelValue
    ]
  );
  const agentProbeLines = useMemo(() => {
    return buildDockAgentProbeTooltipLines(
      activeAgentProbe,
      workspaceAgentProbes?.isLoadingAvailability ?? false,
      t,
      {
        includeUsageLines: true,
        isLoadingUsage: workspaceAgentProbes?.isLoadingUsage ?? false
      }
    );
  }, [
    activeAgentProbe,
    workspaceAgentProbes?.isLoadingAvailability,
    workspaceAgentProbes?.isLoadingUsage,
    t
  ]);

  useEffect(() => {
    if (previewMode || !onAgentProbeDemandChange) {
      return;
    }
    const probeSourceId = `agent-gui:${nodeId}`;
    onAgentProbeDemandChange(activeProbeProvider, probeSourceId);
    return () => {
      onAgentProbeDemandChange(null, probeSourceId);
    };
  }, [activeProbeProvider, nodeId, onAgentProbeDemandChange, previewMode]);

  return (
    <WorkspaceNodeWindow
      nodeId={nodeId}
      kind="agentGui"
      title={windowTitle}
      titleIcon={
        windowTitleIconUrl ? (
          <img
            src={windowTitleIconUrl}
            alt=""
            draggable={false}
            aria-hidden="true"
            className="size-4 rounded-[4px]"
            data-agent-gui-window-provider-icon="true"
          />
        ) : null
      }
      position={position}
      width={width}
      height={height}
      desktopSize={desktopSize}
      minSize={minSize}
      appearance={embedded ? "embedded" : "window"}
      className="size-full bg-transparent"
      bodyClassName={`${styles.shell} nodrag size-full min-h-0 min-w-0 !bg-transparent p-0`}
      hideHeader={embedded}
      titleAccessory={
        <span className="inline-flex flex-none items-center gap-1">
          <AgentProbeInfoPopover
            lines={agentProbeLines}
            testId="agent-gui-window-agent-info"
            className={styles.windowAgentInfo}
          />
          <CanvasNodeGhostIconButton
            aria-label={
              isConversationRailCollapsed
                ? t("agentHost.agentGui.expandConversationRail")
                : t("agentHost.agentGui.collapseConversationRail")
            }
            title={
              isConversationRailCollapsed
                ? t("agentHost.agentGui.expandConversationRail")
                : t("agentHost.agentGui.collapseConversationRail")
            }
            data-testid="agent-gui-toggle-conversation-rail"
            data-agent-gui-conversation-rail-collapsed={
              isConversationRailCollapsed ? "true" : "false"
            }
            data-agent-gui-conversation-rail-auto-collapsed={
              isConversationRailAutoCollapsed ? "true" : "false"
            }
            onClick={(event) => {
              event.stopPropagation();
              handleConversationRailToggle();
            }}
          >
            <CanvasNodePanelLinedIcon
              width={18}
              height={18}
              aria-hidden="true"
            />
          </CanvasNodeGhostIconButton>
        </span>
      }
      onClose={onClose}
      onResize={onResize}
      isMaximized={isMaximized}
      isMuted={isMuted}
      hideMaximizeButton
      onMinimize={onMinimize}
      onToggleMaximize={onToggleMaximize}
    >
      {(renderFrame) => {
        const renderedWidth = renderFrame.size.width;
        const isRenderedConversationRailCollapsed =
          isConversationRailCollapsed ||
          shouldAutoCollapseAgentGUIConversationRail(renderedWidth);

        return (
          <AgentGUINodeView
            viewModel={viewModel}
            actions={viewActions}
            isActive={isActive}
            composerFocusRequestSequence={composerFocusRequestSequence}
            newConversationRequestSequence={newConversationRequestSequence}
            isAgentProviderReady={isActiveAgentProviderReady}
            slashStatusLimits={slashStatusLimits}
            slashStatusLimitsLoading={
              workspaceAgentProbes?.isLoadingUsage ?? false
            }
            previewMode={previewMode}
            onLinkAction={handleLinkAction}
            capabilityMenuState={capabilityMenuState}
            onCapabilitySettingsRequest={onCapabilitySettingsRequest}
            onAgentProviderLogin={
              onAgentProviderLogin ? handleAgentProviderLogin : undefined
            }
            conversationRailCollapsed={isRenderedConversationRailCollapsed}
            conversationRailWidthPx={clampAgentGUIConversationRailWidthPx(
              state.conversationRailWidthPx,
              renderedWidth
            )}
            conversationRailMinWidthPx={
              AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX
            }
            conversationRailMaxWidthPx={resolveAgentGUIConversationRailMaxWidthPx(
              renderedWidth
            )}
            detailMinWidthPx={AGENT_GUI_DETAIL_MIN_WIDTH_PX}
            uiLanguage={locale}
            onWorkspaceFileReferencesAdded={
              onWorkspaceFileReferencesAdded
                ? handleWorkspaceFileReferencesAdded
                : undefined
            }
            onConversationRailWidthChanged={handleConversationRailWidthChanged}
            labels={labels}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
            workspaceFileManagerCopy={workspaceFileManagerI18n}
            workspaceFileReferenceAdapter={workspaceFileReferenceAdapter}
            onOpenConversationWindow={onOpenConversationWindow}
            onRequestGitBranches={onRequestGitBranches}
            selectProjectDirectory={selectProjectDirectory}
            referenceSourceAggregator={referenceSourceAggregator}
            resolveMentionReferenceTarget={resolveMentionReferenceTarget}
            resolveWorkspaceReferenceInitialTarget={
              resolveWorkspaceReferenceInitialTarget
            }
            workspaceFileReferenceCopy={workspaceFileReferenceCopy}
            contextMentionProviders={contextMentionProviders}
            workspaceAppIcons={workspaceAppIcons}
          />
        );
      }}
    </WorkspaceNodeWindow>
  );
}, areAgentGUINodePropsEqual);
