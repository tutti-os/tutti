import { memo, useCallback, useEffect, useMemo } from "react";
import { createWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { createWorkspaceFileManagerI18nRuntime } from "@tutti-os/workspace-file-manager";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import { useTranslation } from "../../i18n/index";
import type { AgentProvider } from "../../contexts/settings/domain/agentSettings";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type { AgentGUINodeData } from "../../types";
import { resolveCanonicalNodeMinSize } from "../../utils/workspaceNodeSizing";
import { WorkspaceNodeWindow } from "../shared/WorkspaceNodeWindow";
import { CanvasNodeGhostIconButton } from "../shared/CanvasNodeGhostIconButton";
import { CanvasNodePanelLinedIcon } from "../shared/canvasNodeChromeIcons";
import { useAgentGUINodeController } from "./controller/useAgentGUINodeController";
import { AgentGUINodeView } from "./AgentGUINodeView";
import {
  normalizeAgentGUIProviderIdentity,
  resolveAgentGUIProviderDisplayLabel
} from "./model/agentGuiProviderIdentity";
import {
  buildDockAgentProbeTooltipLines,
  findWorkspaceAgentProbeForDockProvider
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
import type { AgentGUINodeProps } from "./AgentGUINode.types";
import { areAgentGUINodePropsEqual } from "./AgentGUINode.types";
import {
  useAgentGUIViewLabels,
  useAgentGUIWorkspaceFileReferenceCopy
} from "./AgentGUINode.labels";
import {
  resolveAgentGUIRailStatusProvider,
  slashStatusLimitsFromQuotas,
  slashStatusQuotasFromCanonicalUsage
} from "./AgentGUINode.usage";

export type { AgentGUINodeProps } from "./AgentGUINode.types";

export const AgentGUINode = memo(function AgentGUINode({
  identity,
  workspace,
  frame,
  state,
  runtimeRequests,
  hostCapabilities,
  hostActions,
  renderSlots
}: AgentGUINodeProps): React.JSX.Element {
  "use memo";
  const { nodeId, workspaceId, currentUserId, title } = identity;
  const {
    path: workspacePath,
    fileReferenceAdapter: workspaceFileReferenceAdapter = null,
    onRequestGitBranches = null,
    selectProjectDirectory,
    resolveDroppedFileReferences = null,
    referenceSourceAggregator = null,
    resolveReferenceEntryIconUrl: resolveWorkspaceReferenceEntryIconUrl,
    resolveMentionReferenceTarget = null,
    resolveReferenceInitialTarget:
      resolveWorkspaceReferenceInitialTarget = null,
    onFileReferencesAdded: onWorkspaceFileReferencesAdded,
    agentSettings
  } = workspace;
  const {
    position,
    width,
    height,
    desktopSize,
    isMaximized = false,
    isActive,
    embedded = false,
    previewMode = false,
    conversationRailAutoCollapseWidthPx = null
  } = frame;
  const railAutoCollapseWidthPx =
    conversationRailAutoCollapseWidthPx ?? undefined;
  const {
    composerFocusSequence: composerFocusRequestSequence = null,
    newConversationSequence: newConversationRequestSequence = null,
    openSession: openSessionRequest = null,
    prefillPrompt: prefillPromptRequest = null,
    agentProbes: workspaceAgentProbes,
    onProbeDemandChange: onAgentProbeDemandChange,
    onProbeRefreshRequest: onAgentProbeRefreshRequest
  } = runtimeRequests;
  const {
    capabilityMenuState,
    accountMenuState = null,
    agentTargets,
    agentTargetsLoading = false,
    providerRailAllPresentation = null,
    providerRailMode = "catalog",
    comingSoonProviders,
    providerReadinessGates = null,
    defaultAgentTargetId = null,
    providerAuthAccountLabels,
    managedAgentsState,
    contextMentionProviders,
    workspaceAppIcons
  } = hostCapabilities;
  const {
    onLinkAction,
    onHandoffConversation,
    onCapabilitySettingsRequest,
    onAgentProviderLogin,
    onOpenConversationWindow,
    onClose,
    onResize,
    onUpdateNode,
    onRememberComposerDefaults,
    isMuted = false,
    onMinimize,
    onToggleMaximize,
    onShowMessage
  } = hostActions;
  const {
    providerRailEmpty: renderProviderRailEmpty,
    providerUnavailableState: renderProviderUnavailableState,
    sidebarFooter: renderSidebarFooter
  } = renderSlots;
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
      const agentTargetId = state.agentTargetId?.trim() || null;
      onLinkAction?.(
        action.type === "open-agent-session" &&
          !action.agentTargetId &&
          agentTargetId
          ? { ...action, agentTargetId }
          : action
      );
    },
    [onLinkAction, state.agentTargetId]
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
    shouldAutoCollapseAgentGUIConversationRail(width, railAutoCollapseWidthPx);
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
    agentTargets,
    agentTargetsLoading,
    providerRailMode,
    comingSoonProviders,
    providerReadinessGates,
    defaultAgentTargetId,
    previewMode,
    onDataChange: handleDataChange,
    onRememberComposerDefaults,
    onShowMessage
  });
  const handleCreateConversation = useCallback(
    (...args: Parameters<typeof actions.createConversation>) => {
      if (!previewMode) {
        onUpdateNode((current) =>
          current.lastActiveAgentSessionId === null
            ? current
            : {
                ...current,
                lastActiveAgentSessionId: null
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
    viewModel.rail.activeConversation?.provider ?? state.provider;
  const activeReadinessProvider =
    viewModel.rail.activeConversationId !== null
      ? activeProvider
      : viewModel.rail.selectedAgentTarget.provider;
  const selectedAgentTargetLabel =
    viewModel.rail.selectedAgentTarget?.label ??
    resolveAgentGUIProviderDisplayLabel(state.provider, fallbackAgentTitle);
  const displayProviderLabel = viewModel.rail.activeConversation
    ? resolveAgentGUIProviderDisplayLabel(activeProvider, fallbackAgentTitle)
    : selectedAgentTargetLabel;
  const labels = useAgentGUIViewLabels({
    displayProviderLabel,
    fallbackAgentTitle,
    t,
    workspaceAppIcons: workspaceAppIcons ?? [],
    workspaceId
  });
  const workspaceFileReferenceCopy = useAgentGUIWorkspaceFileReferenceCopy(t);
  const windowTitle = title;
  const activeProbeProvider = activeProvider as AgentProvider;
  const railStatusProvider = useMemo(
    () =>
      resolveAgentGUIRailStatusProvider({
        conversationFilter: viewModel.rail.conversationFilter,
        agentTargets: viewModel.rail.agentTargets
      }),
    [viewModel.rail.conversationFilter, viewModel.rail.agentTargets]
  );
  const activeAgentProbe = useMemo(
    () =>
      findWorkspaceAgentProbeForDockProvider(
        workspaceAgentProbes?.snapshot ?? null,
        activeProbeProvider
      ),
    [activeProbeProvider, workspaceAgentProbes?.snapshot]
  );
  const railAgentProbe = useMemo(
    () =>
      railStatusProvider
        ? findWorkspaceAgentProbeForDockProvider(
            workspaceAgentProbes?.snapshot ?? null,
            railStatusProvider
          )
        : null,
    [railStatusProvider, workspaceAgentProbes?.snapshot]
  );
  const isActiveAgentProviderReady = useMemo(() => {
    const managedAgent = getAgentHostManagedToolchainAgentByName(
      activeReadinessProvider
    );
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
  }, [activeReadinessProvider, managedAgentsState]);
  const canonicalSlashStatusQuotas = slashStatusQuotasFromCanonicalUsage(
    viewModel.detail.usage
  );
  const slashStatusQuotaSource =
    canonicalSlashStatusQuotas.length > 0
      ? canonicalSlashStatusQuotas
      : activeAgentProbe?.usage?.quotas &&
          activeAgentProbe.usage.quotas.length > 0
        ? activeAgentProbe.usage.quotas
        : [];
  const slashStatusLimits = useMemo(
    () =>
      slashStatusLimitsFromQuotas(
        slashStatusQuotaSource,
        viewModel.composer.composerSettings.selectedModelValue ??
          viewModel.composer.composerSettings.draftSettings.model,
        t
      ),
    [
      slashStatusQuotaSource,
      t,
      viewModel.composer.composerSettings.draftSettings.model,
      viewModel.composer.composerSettings.selectedModelValue
    ]
  );
  const slashStatusLimitsUnavailable =
    slashStatusLimits.length === 0 &&
    canonicalSlashStatusQuotas.length === 0 &&
    !(workspaceAgentProbes?.isLoadingUsage ?? false) &&
    (Boolean(activeAgentProbe?.usage) || Boolean(activeAgentProbe?.lastError));
  const railSlashStatusQuotaSource =
    railStatusProvider &&
    railAgentProbe?.usage?.quotas &&
    railAgentProbe.usage.quotas.length > 0
      ? railAgentProbe.usage.quotas
      : [];
  const railSlashStatusLimits = useMemo(
    () => slashStatusLimitsFromQuotas(railSlashStatusQuotaSource, null, t),
    [railSlashStatusQuotaSource, t]
  );
  // The provider whose limits the rail config menu renders: the rail filter
  // provider when one is active, otherwise the active window provider. Read
  // freshness + attempt state from this same probe so an empty or failed usage
  // result stays coherent with the meters (or absence of them).
  const slashStatusUsageProbe = railStatusProvider
    ? railAgentProbe
    : activeAgentProbe;
  const slashStatusUsageCapturedAtUnixMs =
    slashStatusUsageProbe?.usage?.capturedAtUnixMs ?? null;
  const slashStatusUsageDidFail =
    workspaceAgentProbes?.usageLoadFailed ?? false;
  // True once a usage probe has actually run for this provider — it came back
  // with a usage snapshot (possibly zero quotas) or a usage error. Lets the
  // config menu show an explicit "no limits / retry" row instead of hiding the
  // whole section when the numbers resolve empty (e.g. a Claude OAuth usage
  // response with no 5h/7d windows, or a usage fetch the probe caught into
  // `lastError`), which previously made the limits look like they vanished.
  const slashStatusUsageAttempted =
    Boolean(slashStatusUsageProbe?.usage) ||
    Boolean(slashStatusUsageProbe?.lastError);
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
  useEffect(() => {
    if (
      previewMode ||
      !onAgentProbeDemandChange ||
      !railStatusProvider ||
      railStatusProvider === activeProbeProvider
    ) {
      return;
    }
    const probeSourceId = `agent-gui:${nodeId}:rail`;
    onAgentProbeDemandChange(railStatusProvider, probeSourceId);
    return () => {
      onAgentProbeDemandChange(null, probeSourceId);
    };
  }, [
    activeProbeProvider,
    nodeId,
    onAgentProbeDemandChange,
    previewMode,
    railStatusProvider
  ]);
  const handleAgentProbeInfoOpen = useCallback(() => {
    if (previewMode || !onAgentProbeRefreshRequest) {
      return;
    }
    onAgentProbeRefreshRequest(activeProbeProvider, `agent-gui:${nodeId}`);
  }, [activeProbeProvider, nodeId, onAgentProbeRefreshRequest, previewMode]);
  // The rail's "usage & environment check" menu (AgentGUINodeView's
  // agent-gui-config-menu popover) shows the same quota data as the window
  // title's info tooltip above, but through a click rather than a hover. It
  // needs the same on-open refresh (see handleAgentProbeInfoOpen) — otherwise
  // a stale/empty probe fetched before a provider finished installing never
  // gets a chance to refresh here, and the usage meters stay blank until some
  // unrelated event happens to touch the info tooltip instead.
  const handleAgentConfigMenuOpen = useCallback(() => {
    if (previewMode || !onAgentProbeRefreshRequest) {
      return;
    }
    onAgentProbeRefreshRequest(
      railStatusProvider ?? activeProbeProvider,
      `agent-gui:${nodeId}:config`
    );
  }, [
    activeProbeProvider,
    nodeId,
    onAgentProbeRefreshRequest,
    previewMode,
    railStatusProvider
  ]);
  // Manual "refresh now" from the config menu's freshness control. Same probe
  // fetch as opening the menu, but callable while the menu stays open (open-only
  // handlers fire once on the open transition). The control disables itself
  // while a fetch is in flight, so this cannot hammer the vendor usage API.
  const handleAgentUsageRefresh = useCallback(() => {
    if (previewMode || !onAgentProbeRefreshRequest) {
      return;
    }
    onAgentProbeRefreshRequest(
      railStatusProvider ?? activeProbeProvider,
      `agent-gui:${nodeId}:usage-refresh`
    );
  }, [
    activeProbeProvider,
    nodeId,
    onAgentProbeRefreshRequest,
    previewMode,
    railStatusProvider
  ]);

  return (
    <WorkspaceNodeWindow
      nodeId={nodeId}
      kind="agentGui"
      title={windowTitle}
      titleIcon={null}
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
            onOpen={handleAgentProbeInfoOpen}
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
          shouldAutoCollapseAgentGUIConversationRail(
            renderedWidth,
            railAutoCollapseWidthPx
          );

        return (
          <AgentGUINodeView
            viewModel={viewModel}
            renderSidebarFooter={renderSidebarFooter}
            renderProviderRailEmpty={renderProviderRailEmpty}
            renderProviderUnavailableState={renderProviderUnavailableState}
            providerRailAllPresentation={providerRailAllPresentation}
            actions={viewActions}
            isActive={isActive}
            composerFocusRequestSequence={composerFocusRequestSequence}
            newConversationRequestSequence={newConversationRequestSequence}
            isAgentProviderReady={isActiveAgentProviderReady}
            slashStatusLimits={slashStatusLimits}
            slashStatusLimitsLoading={
              workspaceAgentProbes?.isLoadingUsage ?? false
            }
            slashStatusLimitsUnavailable={slashStatusLimitsUnavailable}
            railConfigProvider={railStatusProvider}
            railSlashStatusLimits={railSlashStatusLimits}
            slashStatusUsageCapturedAtUnixMs={slashStatusUsageCapturedAtUnixMs}
            slashStatusUsageDidFail={slashStatusUsageDidFail}
            slashStatusUsageAttempted={slashStatusUsageAttempted}
            providerAuthAccountLabels={providerAuthAccountLabels}
            onAgentConfigMenuOpen={handleAgentConfigMenuOpen}
            onAgentUsageRefresh={handleAgentUsageRefresh}
            onSlashStatusOpen={handleAgentProbeInfoOpen}
            previewMode={previewMode}
            onLinkAction={handleLinkAction}
            onHandoffConversation={onHandoffConversation}
            capabilityMenuState={capabilityMenuState}
            onCapabilitySettingsRequest={onCapabilitySettingsRequest}
            onAgentProviderLogin={
              onAgentProviderLogin ? handleAgentProviderLogin : undefined
            }
            accountMenuState={accountMenuState}
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
            resolveDroppedFileReferences={resolveDroppedFileReferences}
            onConversationRailWidthChanged={handleConversationRailWidthChanged}
            labels={labels}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
            workspaceFileManagerCopy={workspaceFileManagerI18n}
            workspaceFileReferenceAdapter={workspaceFileReferenceAdapter}
            onOpenConversationWindow={onOpenConversationWindow}
            onRequestGitBranches={onRequestGitBranches}
            selectProjectDirectory={selectProjectDirectory}
            referenceSourceAggregator={referenceSourceAggregator}
            resolveWorkspaceReferenceEntryIconUrl={
              resolveWorkspaceReferenceEntryIconUrl
            }
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
