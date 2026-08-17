import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { openWorkspaceSettingsPanel } from "../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import {
  AgentTargetPresentationProvider,
  type AgentMessageMarkdownAgentTarget
} from "../../shared/AgentTargetPresentationContext";
import { AgentTargetInfoRendererProvider } from "../../shared/AgentTargetInfoRendererContext";
import { AgentConversationClockProvider } from "../../shared/agentConversation/components/AgentConversationClock";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import {
  mentionAgentTargetPresentationKey,
  projectMentionAgentTargetPresentations
} from "./model/agentGuiTargetPresentation";
import styles from "./AgentGUINode.styles";
import {
  fallbackWorkspaceFileReferenceCopy,
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./view/agentGUIViewUtils";
import { AgentGUIConfigMenu } from "./view/AgentGUIAccountConfig";
import { AgentGUIProviderRail } from "./view/AgentGUIProviderRail";
import { type AgentGUIConversationRailState } from "./view/AgentGUIConversationRailPane";
import { AgentGUIConversationRailController } from "./controller/AgentGUIConversationRailController";
import {
  AgentGUIDetailPane,
  EMPTY_WORKSPACE_APP_ICONS
} from "./view/AgentGUIDetailPane";
import { mergeWorkspaceAppIconsFromCommands } from "./view/agentGUIDetailModelHelpers";
import { AgentGUIRenameConversationDialog } from "./view/AgentGUIRenameConversationDialog";
import { AgentGUIReferencePickerSurface } from "./view/AgentGUIReferencePickerSurface";
import {
  AgentTargetSetupRoot,
  useAgentTargetSetupRoot
} from "./view/AgentTargetSetupRoot";
import { useAgentGUIWorkspaceReferencePicker } from "./view/useAgentGUIWorkspaceReferencePicker";
import type { AgentGUINodeViewProps } from "./view/AgentGUINodeView.types";
import { useAgentGUINodeEngagement } from "./engagement/useAgentGUINodeEngagement";
import { isAgentGUIProviderReady } from "./model/agentGuiProviderReadiness";
import {
  resolveAgentGUIRailConfigProvider,
  resolveAgentGUIRailStatusTarget
} from "./AgentGUINode.usage";
import {
  useAgentGUIConversationRailResizePointerMove,
  type AgentGUIConversationRailResizeInteraction
} from "./view/useAgentGUIConversationRailResizePointerMove";
export type {
  AgentGUIComposerFooterAccessoryContext,
  AgentGUIComposerFooterAccessoryRenderer
} from "./view/AgentGUIComposerFooterAccessory.types";
export * from "./AgentGUINodeView.publicTypes";
export {
  buildAgentConversationHandoffPrompt,
  handoffProjectPathForConversation,
  isContextCanceledMessage,
  isDifferentKnownConversationOwner,
  resolveActiveConversationBusyStatus,
  resolveConversationDetailStatus,
  resolveSlashStatus,
  useStableSlashStatus
} from "./view/agentGUIDetailModelHelpers";
export {
  resolveAgentGUIHeroIconUrl,
  shouldEmphasizeEmptyHeroProvider
} from "./view/AgentGUIEmptyState";
import { useAgentGUIExternalRequests } from "./view/useAgentGUIExternalRequests";
export function AgentGUINodeView({
  viewModel,
  mentionAgentTargets,
  referenceProvenanceFilters = null,
  sessionInputHistoryEnabled = false,
  sessionForkEnabled = false,
  sessionWorktreeEnabled = false,
  sessionLaunchModesByProjectSectionKey,
  onSessionLaunchModePreferenceChange,
  renderAgentTargetInfo,
  renderProjectDirectoryPickerHeaderActions,
  projectSelectOptions,
  renderReferencePickerSidebarActions,
  renderSidebarFooter,
  renderProviderRailEmpty,
  providerRailAllPresentation,
  onLinkAction,
  onHandoffConversation,
  showHandoffTargetOwnershipLabels = false,
  capabilityMenuState,
  capabilityControlsReadOnly = false,
  onCapabilitySettingsRequest,
  isActive = true,
  isVisible = true,
  onEngagementEvent,
  composerFocusRequestSequence = null,
  workbenchCommandBridge = null,
  slashStatusLimits = [],
  slashStatusLimitsLoading = false,
  slashStatusLimitsUnavailable = false,
  slashStatusOverride = null,
  providerAuthAccountLabels,
  railConfigProvider,
  railSlashStatusLimits,
  slashStatusLimitsResolvedEmpty = false,
  slashStatusUsageCapturedAtUnixMs = null,
  slashStatusUsageDidFail = false,
  slashStatusUsageErrorMessage = null,
  slashStatusUsageAttempted = false,
  agentConfigAccountContent,
  onAgentConfigMenuClose,
  onAgentConfigMenuOpen,
  onAgentUsageRefresh,
  onSlashStatusOpen,
  onSlashStatusClose,
  onSlashStatusRefresh,
  onAgentProviderLogin,
  onAgentEnvPanelOpen,
  actions,
  conversationRailCollapsed,
  conversationRailWidthPx,
  conversationRailMinWidthPx,
  conversationRailMaxWidthPx,
  detailMinWidthPx,
  uiLanguage,
  onWorkspaceFileReferencesAdded,
  resolveExternalPromptEntries = null,
  prepareExternalPromptFiles = null,
  resolvePastedPath = null,
  promptAssetLimit = null,
  onConversationRailWidthChanged,
  onConversationRailLayoutChange,
  labels,
  conversationRailLabels,
  workspaceUserProjectI18n,
  workspaceFileManagerCopy = null,
  workspaceFileReferenceAdapter = null,
  onOpenConversationWindow,
  selectProjectDirectory,
  workspaceFileReferenceCopy = null,
  onRequestGitBranches = null,
  projectDirectorySourceAggregator = null,
  referenceSourceAggregator = null,
  resolveReferenceContentErrorAction,
  resolveWorkspaceReferenceEntryIconUrl,
  resolveMentionReferenceTarget = null,
  resolveWorkspaceReferenceInitialTarget = null,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
  renderComposerFooterAccessory
}: AgentGUINodeViewProps): React.JSX.Element {
  "use memo";
  const isAgentProviderReady = isAgentGUIProviderReady(
    viewModel.readiness.providerReadinessGate
  );
  const { composerEngagement, layoutElementRef } = useAgentGUINodeEngagement({
    composerReady: isAgentProviderReady,
    isActive,
    isVisible,
    onEvent: onEngagementEvent,
    viewModel
  });
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const railResizeInteractionRef =
    useRef<AgentGUIConversationRailResizeInteraction | null>(null);
  const [isRailResizing, setIsRailResizing] = useState(false);
  const [railResizeWidthPx, setRailResizeWidthPx] = useState<number | null>(
    null
  );
  const [
    localComposerFocusRequestSequence,
    setLocalComposerFocusRequestSequence
  ] = useState(0);
  const {
    closeWorkspaceReferencePicker,
    confirmWorkspaceReferenceBundles,
    confirmWorkspaceReferencePicker,
    isWorkspaceReferencePickerNodeSelectable,
    requestProjectDirectory,
    requestWorkspaceReferences,
    workspaceReferencePickerAggregator,
    workspaceReferencePickerOpen,
    workspaceReferencePickerPurpose,
    workspaceReferencePickerTarget
  } = useAgentGUIWorkspaceReferencePicker({
    onWorkspaceFileReferencesAdded,
    projectDirectorySourceAggregator,
    referenceSourceAggregator,
    resolveMentionReferenceTarget,
    resolveWorkspaceReferenceInitialTarget,
    viewModel,
    workspaceFileReferenceAdapter,
    workspaceFileReferenceCopy
  });
  const effectiveSelectProjectDirectory = projectDirectorySourceAggregator
    ? requestProjectDirectory
    : selectProjectDirectory;
  const createConversationDisabled =
    viewModel.rail.selectedAgentTarget.disabled === true;
  const createConversationAction = useStableEventCallback(
    actions.createConversation
  );
  const selectConversation = useStableEventCallback(actions.selectConversation);
  const toggleConversationPinned = useStableEventCallback(
    actions.toggleConversationPinned
  );
  const removeProject = useStableEventCallback(actions.removeProject);
  const moveProject = useStableEventCallback(actions.moveProject);
  const toggleProjectPinned = useStableEventCallback(
    actions.toggleProjectPinned
  );
  const projectDelete = actions.confirmDeleteProjectConversations;
  const confirmProjectDelete = useStableEventCallback(projectDelete);
  const conversationDelete = actions.confirmDeleteConversations;
  const confirmConversationDelete = useStableEventCallback(conversationDelete);
  const requestDeleteConversation = useStableEventCallback(
    actions.requestDeleteConversation
  );
  const cancelDeleteConversation = useStableEventCallback(
    actions.cancelDeleteConversation
  );
  const confirmDeleteConversation = useStableEventCallback(
    actions.confirmDeleteConversation
  );
  const openConversationWindow = useOptionalStableEventCallback(
    onOpenConversationWindow
  );
  const openProjectFiles = useOptionalStableEventCallback(onLinkAction);
  const detailComposerFocusRequestSequence =
    localComposerFocusRequestSequence === 0
      ? composerFocusRequestSequence
      : (composerFocusRequestSequence ?? 0) + localComposerFocusRequestSequence;
  const requestComposerFocus = useCallback(() => {
    setLocalComposerFocusRequestSequence((current) => current + 1);
  }, []);
  const requestCreateConversation = useStableEventCallback(
    (options?: { projectPath?: string | null; source?: string }) => {
      createConversationAction(options);
      requestComposerFocus();
    }
  );
  const effectiveWorkspaceAppIcons = useMemo(
    () =>
      mergeWorkspaceAppIconsFromCommands({
        commands: viewModel.composer.availableCommands,
        workspaceAppIcons,
        workspaceId: viewModel.shell.workspaceId
      }),
    [
      viewModel.composer.availableCommands,
      viewModel.shell.workspaceId,
      workspaceAppIcons
    ]
  );
  const clampConversationRailWidth = useCallback(
    (widthPx: number) =>
      Math.min(
        conversationRailMaxWidthPx,
        Math.max(conversationRailMinWidthPx, widthPx)
      ),
    [conversationRailMaxWidthPx, conversationRailMinWidthPx]
  );
  const providerRailWidthPx = conversationRailCollapsed ? 0 : 52;
  const handleConversationRailResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (conversationRailCollapsed || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      railResizeInteractionRef.current = {
        lastWidthPx: conversationRailWidthPx,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidthPx: conversationRailWidthPx
      };
      setRailResizeWidthPx(conversationRailWidthPx);
      setIsRailResizing(true);
    },
    [conversationRailCollapsed, conversationRailWidthPx]
  );
  const handleConversationRailResizePointerMove =
    useAgentGUIConversationRailResizePointerMove({
      clampConversationRailWidth,
      layoutElementRef,
      onConversationRailLayoutChange,
      providerRailWidthPx,
      railResizeInteractionRef
    });
  const endConversationRailResize = useCallback(
    (event?: PointerEvent<HTMLDivElement>): void => {
      const resizeState = railResizeInteractionRef.current;
      if (
        event &&
        resizeState?.pointerId === event.pointerId &&
        event.currentTarget.hasPointerCapture?.(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      railResizeInteractionRef.current = null;
      if (resizeState) {
        const nextWidthPx = resizeState.lastWidthPx;
        setRailResizeWidthPx(nextWidthPx);
        onConversationRailWidthChanged(nextWidthPx);
      } else {
        setRailResizeWidthPx(null);
      }
      setIsRailResizing(false);
    },
    [onConversationRailWidthChanged]
  );
  useEffect(() => {
    if (isRailResizing || railResizeWidthPx === null) {
      return;
    }
    if (
      conversationRailCollapsed ||
      conversationRailWidthPx === railResizeWidthPx
    ) {
      setRailResizeWidthPx(null);
    }
  }, [
    conversationRailCollapsed,
    conversationRailWidthPx,
    isRailResizing,
    railResizeWidthPx
  ]);

  const handleConversationRailResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (conversationRailCollapsed) {
        return;
      }

      const stepPx = event.shiftKey ? 48 : 16;
      const direction =
        event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (direction === 0) {
        return;
      }

      event.preventDefault();
      onConversationRailWidthChanged(
        clampConversationRailWidth(conversationRailWidthPx + direction * stepPx)
      );
    },
    [
      clampConversationRailWidth,
      conversationRailCollapsed,
      conversationRailWidthPx,
      onConversationRailWidthChanged
    ]
  );

  const visualConversationRailWidthPx = isRailResizing
    ? (railResizeInteractionRef.current?.lastWidthPx ?? conversationRailWidthPx)
    : (railResizeWidthPx ?? conversationRailWidthPx);
  const effectiveConversationRailWidthPx = conversationRailCollapsed
    ? 0
    : visualConversationRailWidthPx;

  const layoutStyle = {
    "--agent-gui-conversation-rail-width": `${effectiveConversationRailWidthPx}px`,
    "--agent-gui-conversation-rail-content-width": `${visualConversationRailWidthPx}px`,
    "--agent-gui-detail-min-width": `${detailMinWidthPx}px`,
    "--agent-gui-provider-rail-width": `${providerRailWidthPx}px`,
    gridTemplateColumns:
      "var(--agent-gui-provider-rail-width) var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
  } as CSSProperties;
  const effectiveRailConfigProvider = resolveAgentGUIRailConfigProvider(
    railConfigProvider,
    viewModel.shell.data.provider
  );
  const railConfigTarget = resolveAgentGUIRailStatusTarget(viewModel.rail);
  const effectiveRailSlashStatusLimits =
    railSlashStatusLimits ?? slashStatusLimits;
  const shouldShowProviderRailConfigButton =
    viewModel.rail.conversationFilter.kind === "all" ||
    viewModel.rail.selectedAgentTarget?.disabled !== true;
  const effectiveProviderAuthAccountLabel = useMemo(() => {
    const provider = effectiveRailConfigProvider?.trim() ?? "";
    if (!provider) {
      return null;
    }
    const label = providerAuthAccountLabels?.[provider]?.trim();
    return label || null;
  }, [effectiveRailConfigProvider, providerAuthAccountLabels]);
  const {
    controller: targetSetupController,
    environmentSetupVisible,
    homeTargetProjection,
    openAgentEnvSetup
  } = useAgentTargetSetupRoot({
    activeConversationId: viewModel.rail.activeConversationId,
    agentTargets: viewModel.rail.agentTargets,
    environmentProvider: effectiveRailConfigProvider,
    openEnvironmentSetup: onAgentEnvPanelOpen,
    selectedAgentTarget: viewModel.rail.selectedAgentTarget
  });
  const openAgentSettings = useCallback(() => {
    openWorkspaceSettingsPanel({
      section: "agent",
      pane: "agents",
      provider: effectiveRailConfigProvider ?? undefined
    });
  }, [effectiveRailConfigProvider]);
  const [renameConversationTarget, setRenameConversationTarget] = useState<
    AgentGUINodeViewModel["rail"]["conversations"][number] | null
  >(null);
  const [renameConversationDialogOpen, setRenameConversationDialogOpen] =
    useState(false);
  const requestRenameConversation = useCallback(
    (conversation: AgentGUINodeViewModel["rail"]["conversations"][number]) => {
      setRenameConversationTarget(conversation);
      setRenameConversationDialogOpen(true);
    },
    []
  );
  const { registerRailInteractionLockProbe } = useAgentGUIExternalRequests({
    createConversationDisabled,
    labels,
    requestCreateConversation,
    requestRenameConversation,
    uiLanguage,
    viewModel,
    workbenchCommandBridge
  });
  const conversationRailStoreState = useMemo<AgentGUIConversationRailState>(
    () => ({
      activeConversation: viewModel.rail.activeConversation,
      activeConversationId: viewModel.rail.activeConversationId,
      revealRequest: viewModel.rail.revealRequest,
      pendingDeleteConversationId:
        viewModel.operations.pendingDeleteConversation?.id ?? null,
      isLoadingConversations: viewModel.rail.isLoadingConversations,
      isDeletingConversation: viewModel.operations.isDeletingConversation,
      isDeletingProjectConversations:
        viewModel.operations.isDeletingProjectConversations,
      isUserProjectMutationPending:
        viewModel.operations.isUserProjectMutationPending,
      labels: conversationRailLabels,
      workspaceUserProjectI18n,
      uiLanguage,
      createConversationDisabled,
      isCollapsed: conversationRailCollapsed,
      agentTargets: viewModel.rail.agentTargets,
      agentTargetsLoading: viewModel.rail.agentTargetsLoading,
      conversationFilter: viewModel.rail.conversationFilter,
      onCreateConversation: requestCreateConversation,
      onUpdateConversationFilter: actions.updateConversationFilter,
      onSelectConversationFilterTarget: actions.selectConversationFilterTarget,
      onSelectConversation: selectConversation,
      onToggleConversationPinned: toggleConversationPinned,
      onMarkConversationUnread: actions.markConversationUnread,
      onRemoveProject: removeProject,
      onMoveProject: moveProject,
      onToggleProjectPinned: toggleProjectPinned,
      onConfirmDeleteProjectConversations: confirmProjectDelete,
      onConfirmDeleteConversations: confirmConversationDelete,
      onRequestDeleteConversation: requestDeleteConversation,
      onRequestRenameConversation: requestRenameConversation,
      onCancelDeleteConversation: cancelDeleteConversation,
      onConfirmDeleteConversation: confirmDeleteConversation,
      onOpenProjectFiles: openProjectFiles,
      onOpenConversationWindow: openConversationWindow,
      selectProjectDirectory: effectiveSelectProjectDirectory
    }),
    [
      cancelDeleteConversation,
      confirmDeleteConversation,
      confirmConversationDelete,
      confirmProjectDelete,
      conversationRailCollapsed,
      createConversationDisabled,
      conversationRailLabels,
      openConversationWindow,
      openProjectFiles,
      actions.markConversationUnread,
      actions.updateConversationFilter,
      removeProject,
      moveProject,
      toggleProjectPinned,
      requestCreateConversation,
      requestDeleteConversation,
      requestRenameConversation,
      selectConversation,
      effectiveSelectProjectDirectory,
      viewModel.rail.agentTargets,
      viewModel.rail.agentTargetsLoading,
      viewModel.rail.revealRequest,
      toggleConversationPinned,
      uiLanguage,
      viewModel.rail.conversationFilter,
      viewModel.rail.activeConversation,
      viewModel.rail.activeConversationId,
      viewModel.operations.isDeletingConversation,
      viewModel.operations.isDeletingProjectConversations,
      viewModel.operations.isUserProjectMutationPending,
      viewModel.rail.isLoadingConversations,
      viewModel.operations.pendingDeleteConversation?.id,
      workspaceUserProjectI18n
    ]
  );
  const targetPresentationKey = mentionAgentTargetPresentationKey(
    viewModel.rail.agentTargets,
    viewModel.composer.handoffAgentTargets,
    mentionAgentTargets
  );
  const agentTargetPresentations = useMemo<
    readonly AgentMessageMarkdownAgentTarget[]
  >(
    () =>
      projectMentionAgentTargetPresentations({
        handoffTargets: viewModel.composer.handoffAgentTargets,
        mentionTargets: mentionAgentTargets,
        ownerSeparator: labels.sharedAgentOwnerSeparator,
        railTargets: viewModel.rail.agentTargets,
        workspaceId: viewModel.shell.workspaceId
      }),
    [
      labels.sharedAgentOwnerSeparator,
      targetPresentationKey,
      viewModel.shell.workspaceId
    ]
  );

  const content = (
    <AgentTargetPresentationProvider agentTargets={agentTargetPresentations}>
      <AgentTargetSetupRoot
        controller={targetSetupController}
        openEnvironmentSetup={onAgentEnvPanelOpen}
      >
        <div
          ref={layoutElementRef}
          className={styles.layout}
          data-agent-gui-active={isActive ? "true" : "false"}
          data-agent-gui-visible={isVisible ? "true" : "false"}
          data-rail-resizing={isRailResizing ? "true" : undefined}
          style={layoutStyle}
        >
          <aside
            className={`${styles.providerRailPanel} nodrag tsh-desktop-no-drag`}
            aria-label={labels.providerSwitchLabel}
            aria-hidden={conversationRailCollapsed ? "true" : undefined}
            inert={conversationRailCollapsed ? true : undefined}
          >
            <AgentGUIProviderRail
              activeConversation={viewModel.rail.activeConversation}
              activeConversationId={viewModel.rail.activeConversationId}
              conversationFilter={viewModel.rail.conversationFilter}
              conversations={viewModel.rail.conversations}
              labels={labels}
              selectedAgentTarget={viewModel.rail.selectedAgentTarget}
              agentTargets={viewModel.rail.agentTargets}
              agentTargetsLoading={viewModel.rail.agentTargetsLoading}
              providerRailMode={viewModel.rail.providerRailMode}
              renderProviderRailEmpty={renderProviderRailEmpty}
              providerRailAllPresentation={providerRailAllPresentation}
              comingSoonProviders={viewModel.rail.comingSoonProviders}
              managerOpen={providerManagerOpen}
              onManagerOpenChange={setProviderManagerOpen}
              onSelectHomeComposerAgentTarget={
                actions.selectHomeComposerAgentTarget
              }
              onSelectConversationFilterTarget={
                actions.selectConversationFilterTarget
              }
              onUpdateConversationFilter={actions.updateConversationFilter}
              onRequestComposerFocus={requestComposerFocus}
            />
            {renderSidebarFooter ? (
              <div
                className={`${styles.providerRailFooter} ${styles.providerRailSidebarFooter} nodrag tsh-desktop-no-drag`}
                data-testid="agent-gui-sidebar-footer-slot"
              >
                {renderSidebarFooter({
                  currentUserId: viewModel.shell.currentUserId,
                  activeConversation: viewModel.rail.activeConversation
                })}
              </div>
            ) : null}
            {shouldShowProviderRailConfigButton ? (
              <div
                className={`${styles.providerRailFooter} ${styles.providerRailConfigFooter} nodrag tsh-desktop-no-drag`}
                data-testid="agent-gui-config-footer"
              >
                <AgentGUIConfigMenu
                  environmentSetupVisible={environmentSetupVisible}
                  labels={labels}
                  providerScopedActionsVisible={
                    viewModel.rail.conversationFilter.kind !== "all"
                  }
                  slashStatusLimits={effectiveRailSlashStatusLimits}
                  slashStatusLimitsLoading={slashStatusLimitsLoading}
                  slashStatusLimitsResolvedEmpty={
                    slashStatusLimitsResolvedEmpty
                  }
                  slashStatusUsageCapturedAtUnixMs={
                    slashStatusUsageCapturedAtUnixMs
                  }
                  slashStatusUsageDidFail={slashStatusUsageDidFail}
                  slashStatusUsageErrorMessage={slashStatusUsageErrorMessage}
                  slashStatusUsageAttempted={slashStatusUsageAttempted}
                  provider={
                    effectiveRailConfigProvider ?? railConfigTarget?.provider
                  }
                  providerIconUrl={railConfigTarget?.iconUrl ?? null}
                  providerMaskIconUrl={railConfigTarget?.maskIconUrl ?? null}
                  providerLabel={railConfigTarget?.label}
                  providerAuthAccountLabel={effectiveProviderAuthAccountLabel}
                  accountContent={agentConfigAccountContent}
                  onAgentConfigMenuClose={onAgentConfigMenuClose}
                  onAgentConfigMenuOpen={onAgentConfigMenuOpen}
                  onAgentUsageRefresh={onAgentUsageRefresh}
                  onOpenAgentEnvSetup={openAgentEnvSetup}
                  onOpenAgentSettings={openAgentSettings}
                />
              </div>
            ) : null}
          </aside>
          <aside
            id="agent-gui-conversation-rail"
            className={`${styles.railPanel}${
              conversationRailCollapsed ? ` ${styles.railPanelCollapsed}` : ""
            }`}
            aria-hidden={conversationRailCollapsed ? "true" : undefined}
            inert={conversationRailCollapsed ? true : undefined}
          >
            <AgentConversationClockProvider isVisible={isVisible}>
              {/* Selecting an Activity row must not rebuild its all-provider snapshot. */}
              <AgentGUIConversationRailController
                {...conversationRailStoreState}
                activityContextKey={[
                  viewModel.shell.currentUserId?.trim() ?? "",
                  viewModel.shell.nodeId?.trim() ?? ""
                ].join("\u0000")}
                conversations={viewModel.rail.conversations}
                currentUserId={viewModel.shell.currentUserId}
                nodeId={viewModel.shell.nodeId}
                registerInteractionLockProbe={registerRailInteractionLockProbe}
                userProjects={viewModel.rail.userProjects}
                workspaceId={viewModel.shell.workspaceId}
              />
            </AgentConversationClockProvider>
          </aside>
          <div
            id="agent-gui-conversation-rail-resize"
            className={
              conversationRailCollapsed
                ? `${styles.railResizeHandle} ${styles.railResizeHandleCollapsed} nodrag pointer-events-none opacity-0`
                : `${styles.railResizeHandle} nodrag`
            }
            role="separator"
            aria-label={labels.conversationRailResizeAria}
            aria-hidden={conversationRailCollapsed ? "true" : undefined}
            aria-orientation="vertical"
            aria-valuemin={conversationRailMinWidthPx}
            aria-valuemax={conversationRailMaxWidthPx}
            aria-valuenow={
              conversationRailCollapsed
                ? undefined
                : visualConversationRailWidthPx
            }
            data-resizing={isRailResizing ? "true" : undefined}
            data-testid="agent-gui-conversation-rail-resize-handle"
            tabIndex={conversationRailCollapsed ? -1 : 0}
            onBlur={() => endConversationRailResize()}
            onKeyDown={handleConversationRailResizeKeyDown}
            onPointerCancel={endConversationRailResize}
            onPointerDown={handleConversationRailResizePointerDown}
            onLostPointerCapture={endConversationRailResize}
            onPointerMove={handleConversationRailResizePointerMove}
            onPointerUp={endConversationRailResize}
          />
          <section id="agent-gui-detail" className={styles.detailPanel}>
            <AgentConversationClockProvider isVisible={isVisible}>
              <AgentGUIDetailPane
                shell={viewModel.shell}
                rail={viewModel.rail}
                detail={viewModel.detail}
                composer={viewModel.composer}
                interaction={viewModel.interaction}
                readiness={viewModel.readiness}
                operations={viewModel.operations}
                homeTargetProjection={homeTargetProjection}
                referenceProvenanceFilters={referenceProvenanceFilters}
                sessionInputHistoryEnabled={sessionInputHistoryEnabled}
                sessionForkEnabled={sessionForkEnabled}
                sessionWorktreeEnabled={sessionWorktreeEnabled}
                sessionLaunchModesByProjectSectionKey={
                  sessionLaunchModesByProjectSectionKey
                }
                onSessionLaunchModePreferenceChange={
                  onSessionLaunchModePreferenceChange
                }
                composerEngagement={composerEngagement}
                actions={actions}
                labels={labels}
                uiLanguage={uiLanguage}
                isActive={isActive}
                isVisible={isVisible}
                workspaceReferencePickerOpen={workspaceReferencePickerOpen}
                composerFocusRequestSequence={
                  detailComposerFocusRequestSequence
                }
                slashStatusLimits={slashStatusLimits}
                slashStatusLimitsLoading={slashStatusLimitsLoading}
                slashStatusLimitsUnavailable={slashStatusLimitsUnavailable}
                slashStatusOverride={slashStatusOverride}
                onSlashStatusOpen={onSlashStatusOpen}
                onSlashStatusClose={onSlashStatusClose}
                onSlashStatusRefresh={onSlashStatusRefresh}
                onLinkAction={onLinkAction}
                onHandoffConversation={onHandoffConversation}
                showHandoffTargetOwnershipLabels={
                  showHandoffTargetOwnershipLabels
                }
                capabilityMenuState={capabilityMenuState}
                capabilityControlsReadOnly={capabilityControlsReadOnly}
                onCapabilitySettingsRequest={onCapabilitySettingsRequest}
                onAgentProviderLogin={onAgentProviderLogin}
                onRequestWorkspaceReferences={requestWorkspaceReferences}
                resolveExternalPromptEntries={resolveExternalPromptEntries}
                prepareExternalPromptFiles={prepareExternalPromptFiles}
                resolvePastedPath={resolvePastedPath}
                promptAssetLimit={promptAssetLimit}
                selectProjectDirectory={effectiveSelectProjectDirectory}
                projectSelectOptions={projectSelectOptions}
                onRequestGitBranches={onRequestGitBranches}
                onRequestComposerFocus={requestComposerFocus}
                workspaceAppIcons={effectiveWorkspaceAppIcons}
                workspaceUserProjectI18n={workspaceUserProjectI18n}
                renderComposerFooterAccessory={renderComposerFooterAccessory}
              />
            </AgentConversationClockProvider>
          </section>
        </div>
        <AgentGUIReferencePickerSurface
          aggregator={workspaceReferencePickerAggregator}
          copy={
            workspaceFileReferenceCopy ?? fallbackWorkspaceFileReferenceCopy
          }
          fileAdapter={workspaceFileReferenceAdapter}
          fileManagerCopy={workspaceFileManagerCopy}
          initialPath={viewModel.composer.composerSettings.selectedProjectPath}
          initialTarget={workspaceReferencePickerTarget}
          isNodeSelectable={isWorkspaceReferencePickerNodeSelectable}
          open={workspaceReferencePickerOpen}
          purpose={workspaceReferencePickerPurpose}
          renderDirectoryHeaderActions={
            renderProjectDirectoryPickerHeaderActions
          }
          renderSidebarActions={renderReferencePickerSidebarActions}
          resolveContentErrorAction={resolveReferenceContentErrorAction}
          resolveEntryIconUrl={resolveWorkspaceReferenceEntryIconUrl}
          workspaceId={viewModel.shell.workspaceId}
          onClose={closeWorkspaceReferencePicker}
          onConfirm={confirmWorkspaceReferencePicker}
          onConfirmBundles={
            workspaceReferencePickerPurpose === "reference"
              ? confirmWorkspaceReferenceBundles
              : undefined
          }
        />
        <AgentGUIRenameConversationDialog
          conversation={renameConversationTarget}
          open={
            renameConversationDialogOpen && renameConversationTarget !== null
          }
          labels={labels}
          onOpenChange={(open) => {
            setRenameConversationDialogOpen(open);
            if (!open) {
              setRenameConversationTarget(null);
            }
          }}
          onRename={actions.renameConversation}
        />
      </AgentTargetSetupRoot>
    </AgentTargetPresentationProvider>
  );
  return (
    <TooltipProvider>
      <AgentTargetInfoRendererProvider
        agentTargets={viewModel.rail.agentTargets}
        renderer={renderAgentTargetInfo}
      >
        {content}
      </AgentTargetInfoRendererProvider>
    </TooltipProvider>
  );
}
