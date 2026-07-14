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
import {
  ReferenceSourcePicker,
  WorkspaceFileReferencePicker
} from "@tutti-os/workspace-file-reference/ui";
import { TooltipProvider } from "@tutti-os/ui-system";
import { openAgentEnvPanel } from "../../shared/agentEnv/agentEnvPanelStore";
import { openWorkspaceSettingsPanel } from "../../shared/workspaceSettingsPanel/workspaceSettingsPanelStore";
import { SettingsLinedIcon } from "../../app/renderer/components/icons/SettingsLinedIcon";
import {
  AgentTargetPresentationProvider,
  type AgentMessageMarkdownAgentTarget
} from "../../shared/AgentTargetPresentationContext";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../shared/AgentMessageMarkdown";
import styles from "./AgentGUINode.styles";
import {
  fallbackWorkspaceFileReferenceCopy,
  useOptionalStableEventCallback,
  useStableEventCallback
} from "./view/agentGUIViewUtils";
import {
  AgentGUIAccountRailMenu,
  AgentGUIConfigMenu
} from "./view/AgentGUIAccountConfig";
import { AgentGUIProviderRail } from "./view/AgentGUIProviderRail";
import {
  AgentGUIConversationRailPane,
  type AgentGUIConversationRailState
} from "./view/AgentGUIConversationRailPane";
import {
  AgentGUIDetailPane,
  mergeWorkspaceAppIconsFromCommands
} from "./view/AgentGUIDetailPane";
import { AgentGUIRenameConversationDialog } from "./view/AgentGUIRenameConversationDialog";
import { useAgentGUIWorkspaceReferencePicker } from "./view/useAgentGUIWorkspaceReferencePicker";
import type { AgentGUINodeViewProps } from "./view/AgentGUINodeView.types";

export type {
  AgentGUINodeViewProps,
  AgentGUIAgentsEmptyRenderer,
  AgentGUIProviderUnavailableStateContext,
  AgentGUIProviderUnavailableStateRenderer,
  AgentGUISidebarFooterContext,
  AgentGUISidebarFooterRenderer,
  AgentGUIViewLabels,
  AgentMentionReferenceTargetResolver,
  AgentWorkspaceReferenceInitialTargetInput,
  AgentWorkspaceReferenceInitialTargetResolver
} from "./view/AgentGUINodeView.types";
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
export { updateConversationSectionsFromSummaries } from "./view/agentGUIConversationRailData";
export {
  resolveAgentGUIHeroIconUrl,
  shouldEmphasizeEmptyHeroProvider
} from "./view/AgentGUIEmptyState";

const EMPTY_WORKSPACE_APP_ICONS: readonly AgentMessageMarkdownWorkspaceAppIcon[] =
  [];

export function AgentGUINodeView({
  viewModel,
  renderSidebarFooter,
  renderProviderRailEmpty,
  renderProviderUnavailableState,
  providerRailAllPresentation,
  onLinkAction,
  onHandoffConversation,
  capabilityMenuState,
  onCapabilitySettingsRequest,
  isActive = true,
  composerFocusRequestSequence = null,
  newConversationRequestSequence = null,
  isAgentProviderReady,
  slashStatusLimits = [],
  slashStatusLimitsLoading = false,
  slashStatusLimitsUnavailable = false,
  providerAuthAccountLabels,
  railConfigProvider,
  railSlashStatusLimits,
  slashStatusUsageCapturedAtUnixMs = null,
  slashStatusUsageDidFail = false,
  slashStatusUsageAttempted = false,
  onAgentConfigMenuOpen,
  onAgentUsageRefresh,
  onSlashStatusOpen,
  accountMenuState = null,
  previewMode = false,
  onAgentProviderLogin,
  actions,
  conversationRailCollapsed,
  conversationRailWidthPx,
  conversationRailMinWidthPx,
  conversationRailMaxWidthPx,
  detailMinWidthPx,
  uiLanguage,
  onWorkspaceFileReferencesAdded,
  resolveDroppedFileReferences = null,
  onConversationRailWidthChanged,
  labels,
  workspaceUserProjectI18n,
  workspaceFileManagerCopy = null,
  workspaceFileReferenceAdapter = null,
  onOpenConversationWindow,
  selectProjectDirectory,
  workspaceFileReferenceCopy = null,
  onRequestGitBranches = null,
  contextMentionProviders,
  referenceSourceAggregator = null,
  resolveWorkspaceReferenceEntryIconUrl,
  resolveMentionReferenceTarget = null,
  resolveWorkspaceReferenceInitialTarget = null,
  workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS
}: AgentGUINodeViewProps): React.JSX.Element {
  "use memo";
  const layoutElementRef = useRef<HTMLDivElement | null>(null);
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const railResizeInteractionRef = useRef<{
    lastWidthPx: number;
    pointerId: number;
    startClientX: number;
    startWidthPx: number;
  } | null>(null);
  const [isRailResizing, setIsRailResizing] = useState(false);
  const [railResizeWidthPx, setRailResizeWidthPx] = useState<number | null>(
    null
  );
  const [
    localComposerFocusRequestSequence,
    setLocalComposerFocusRequestSequence
  ] = useState(0);
  const handledNewConversationRequestSequenceRef = useRef(
    newConversationRequestSequence
  );
  const {
    closeWorkspaceReferencePicker,
    confirmWorkspaceReferenceBundles,
    confirmWorkspaceReferencePicker,
    isWorkspaceReferencePickerNodeSelectable,
    requestWorkspaceReferences,
    workspaceReferencePickerOpen,
    workspaceReferencePickerTarget
  } = useAgentGUIWorkspaceReferencePicker({
    onWorkspaceFileReferencesAdded,
    previewMode,
    referenceSourceAggregator,
    resolveMentionReferenceTarget,
    resolveWorkspaceReferenceInitialTarget,
    viewModel,
    workspaceFileReferenceAdapter,
    workspaceFileReferenceCopy
  });
  const createConversationDisabled =
    viewModel.composer.isCreatingConversation ||
    viewModel.rail.selectedAgentTarget.disabled === true;
  const createConversationAction = useStableEventCallback(
    actions.createConversation
  );
  const selectConversation = useStableEventCallback(actions.selectConversation);
  const toggleConversationPinned = useStableEventCallback(
    actions.toggleConversationPinned
  );
  const removeProject = useStableEventCallback(actions.removeProject);
  const confirmDeleteProjectConversations = useStableEventCallback(
    actions.confirmDeleteProjectConversations
  );
  const confirmDeleteConversations = useStableEventCallback(
    actions.confirmDeleteConversations
  );
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
  const requestCreateConversation = useCallback(
    (options?: { projectPath?: string | null; source?: string }) => {
      if (previewMode) {
        return;
      }
      const source = options?.source;
      if (options && "projectPath" in options) {
        createConversationAction(options);
      } else if (viewModel.composer.composerSettings.selectedProjectPath) {
        createConversationAction({
          projectPath: viewModel.composer.composerSettings.selectedProjectPath,
          source: source ?? "selected_project"
        });
      } else {
        createConversationAction({ source: source ?? "rail_toolbar" });
      }
      requestComposerFocus();
    },
    [
      createConversationAction,
      previewMode,
      requestComposerFocus,
      viewModel.composer.composerSettings.selectedProjectPath
    ]
  );
  useEffect(() => {
    if (
      newConversationRequestSequence === null ||
      handledNewConversationRequestSequenceRef.current ===
        newConversationRequestSequence
    ) {
      return;
    }

    handledNewConversationRequestSequenceRef.current =
      newConversationRequestSequence;
    if (!createConversationDisabled) {
      requestCreateConversation({ source: "external_request" });
    }
  }, [
    createConversationDisabled,
    newConversationRequestSequence,
    requestCreateConversation
  ]);
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

  const handleConversationRailResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (previewMode) {
        return;
      }
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
    [conversationRailCollapsed, conversationRailWidthPx, previewMode]
  );

  const handleConversationRailResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (previewMode) {
        return;
      }
      const resizeState = railResizeInteractionRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }

      const nextWidthPx = clampConversationRailWidth(
        resizeState.startWidthPx + event.clientX - resizeState.startClientX
      );
      if (resizeState.lastWidthPx !== nextWidthPx) {
        resizeState.lastWidthPx = nextWidthPx;
        layoutElementRef.current?.style.setProperty(
          "--agent-gui-conversation-rail-width",
          `${nextWidthPx}px`
        );
        event.currentTarget.setAttribute("aria-valuenow", String(nextWidthPx));
      }
    },
    [clampConversationRailWidth, previewMode]
  );

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
      if (previewMode) {
        return;
      }
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
      onConversationRailWidthChanged,
      previewMode
    ]
  );

  const visualConversationRailWidthPx = isRailResizing
    ? (railResizeInteractionRef.current?.lastWidthPx ?? conversationRailWidthPx)
    : (railResizeWidthPx ?? conversationRailWidthPx);
  const effectiveConversationRailWidthPx = conversationRailCollapsed
    ? 0
    : visualConversationRailWidthPx;
  const showProviderRail = true;
  const renderProviderRail = showProviderRail && !conversationRailCollapsed;

  const layoutStyle = {
    "--agent-gui-conversation-rail-width": `${effectiveConversationRailWidthPx}px`,
    "--agent-gui-conversation-rail-content-width": `${visualConversationRailWidthPx}px`,
    "--agent-gui-detail-min-width": `${detailMinWidthPx}px`,
    "--agent-gui-provider-rail-width": renderProviderRail ? "52px" : "0px",
    gridTemplateColumns: showProviderRail
      ? "var(--agent-gui-provider-rail-width) var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
      : "var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
  } as CSSProperties;
  const effectiveRailConfigProvider =
    railConfigProvider === undefined
      ? viewModel.shell.data.provider
      : railConfigProvider;
  const effectiveRailSlashStatusLimits =
    railSlashStatusLimits ?? slashStatusLimits;
  const shouldShowProviderRailConfigButton =
    viewModel.rail.conversationFilter.kind === "all" ||
    viewModel.rail.selectedAgentTarget?.disabled !== true;
  const shouldShowProviderRailConfigMenu = shouldShowProviderRailConfigButton;
  const effectiveProviderAuthAccountLabel = useMemo(() => {
    const provider =
      (effectiveRailConfigProvider ?? viewModel.shell.data.provider)?.trim() ??
      "";
    if (!provider) {
      return null;
    }
    const label = providerAuthAccountLabels?.[provider]?.trim();
    return label || null;
  }, [
    effectiveRailConfigProvider,
    providerAuthAccountLabels,
    viewModel.shell.data.provider
  ]);
  const enabledProviderTargets = viewModel.rail.agentTargets.filter(
    (target) =>
      target.disabled !== true &&
      ((target.agentTargetId?.trim() ?? "") || (target.targetId?.trim() ?? ""))
  );
  const sectionAgentTargetFallbackId =
    enabledProviderTargets.length <= 1
      ? viewModel.rail.selectedAgentTarget.agentTargetId?.trim() ||
        viewModel.rail.selectedAgentTarget.targetId?.trim() ||
        null
      : null;
  const openAgentEnvSetup = useCallback(() => {
    // In the "All" filter there is no single rail provider; pass it through as
    // null so the env panel host falls back to the default provider.
    openAgentEnvPanel({ provider: effectiveRailConfigProvider, focus: null });
  }, [effectiveRailConfigProvider]);
  const openAgentSettings = useCallback(() => {
    openWorkspaceSettingsPanel({ section: "agent" });
  }, []);
  const [renameConversationTarget, setRenameConversationTarget] = useState<
    AgentGUINodeViewModel["rail"]["conversations"][number] | null
  >(null);
  const [renameConversationDialogOpen, setRenameConversationDialogOpen] =
    useState(false);
  const requestRenameConversation = useCallback(
    (agentSessionId: string) => {
      const target =
        viewModel.rail.conversations.find(
          (conversation) => conversation.id === agentSessionId
        ) ??
        (viewModel.rail.activeConversation?.id === agentSessionId
          ? viewModel.rail.activeConversation
          : null);
      if (target) {
        setRenameConversationTarget(target);
        setRenameConversationDialogOpen(true);
      }
    },
    [viewModel.rail.activeConversation, viewModel.rail.conversations]
  );
  const conversationRailStoreState = useMemo<AgentGUIConversationRailState>(
    () => ({
      activeConversationId: viewModel.rail.activeConversationId,
      pendingDeleteConversationId:
        viewModel.operations.pendingDeleteConversation?.id ?? null,
      isLoadingConversations: viewModel.rail.isLoadingConversations,
      isDeletingConversation: viewModel.operations.isDeletingConversation,
      isDeletingProjectConversations:
        viewModel.operations.isDeletingProjectConversations,
      labels,
      workspaceUserProjectI18n,
      uiLanguage,
      previewMode,
      createConversationDisabled,
      isCollapsed: conversationRailCollapsed,
      agentTargets: viewModel.rail.agentTargets,
      agentTargetsLoading: viewModel.rail.agentTargetsLoading,
      conversationFilter: viewModel.rail.conversationFilter,
      sectionAgentTargetFallbackId,
      onCreateConversation: requestCreateConversation,
      onUpdateConversationFilter: actions.updateConversationFilter,
      onSelectConversationFilterTarget: actions.selectConversationFilterTarget,
      onSelectConversation: selectConversation,
      onToggleConversationPinned: toggleConversationPinned,
      onMarkConversationUnread: actions.markConversationUnread,
      onRemoveProject: removeProject,
      onConfirmDeleteProjectConversations: confirmDeleteProjectConversations,
      onConfirmDeleteConversations: confirmDeleteConversations,
      onRequestDeleteConversation: requestDeleteConversation,
      onRequestRenameConversation: requestRenameConversation,
      onCancelDeleteConversation: cancelDeleteConversation,
      onConfirmDeleteConversation: confirmDeleteConversation,
      onOpenProjectFiles: openProjectFiles,
      onOpenConversationWindow: openConversationWindow,
      selectProjectDirectory
    }),
    [
      cancelDeleteConversation,
      confirmDeleteConversation,
      confirmDeleteConversations,
      confirmDeleteProjectConversations,
      conversationRailCollapsed,
      createConversationDisabled,
      labels,
      openConversationWindow,
      openProjectFiles,
      actions.markConversationUnread,
      actions.updateConversationFilter,
      previewMode,
      removeProject,
      requestCreateConversation,
      requestDeleteConversation,
      requestRenameConversation,
      selectConversation,
      selectProjectDirectory,
      sectionAgentTargetFallbackId,
      viewModel.rail.agentTargets,
      viewModel.rail.agentTargetsLoading,
      toggleConversationPinned,
      uiLanguage,
      viewModel.rail.conversationFilter,
      viewModel.rail.activeConversationId,
      viewModel.operations.isDeletingConversation,
      viewModel.operations.isDeletingProjectConversations,
      viewModel.rail.isLoadingConversations,
      viewModel.operations.pendingDeleteConversation?.id,
      workspaceUserProjectI18n
    ]
  );
  const agentTargetPresentations = useMemo<
    readonly AgentMessageMarkdownAgentTarget[]
  >(
    () =>
      viewModel.rail.agentTargets.flatMap((target) =>
        target.agentTargetId
          ? [
              {
                agentTargetId: target.agentTargetId,
                iconUrl: target.iconUrl ?? null,
                name: target.label,
                provider: target.provider,
                workspaceId: viewModel.shell.workspaceId
              }
            ]
          : []
      ),
    [viewModel.rail.agentTargets, viewModel.shell.workspaceId]
  );

  const content = (
    <AgentTargetPresentationProvider agentTargets={agentTargetPresentations}>
      <div
        ref={layoutElementRef}
        className={styles.layout}
        data-agent-gui-preview={previewMode ? "true" : undefined}
        data-rail-resizing={isRailResizing ? "true" : undefined}
        inert={previewMode ? true : undefined}
        style={layoutStyle}
      >
        {showProviderRail ? (
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
              previewMode={previewMode}
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
            {shouldShowProviderRailConfigButton ? (
              <div
                className={`${styles.providerRailFooter} ${styles.providerRailConfigFooter} nodrag tsh-desktop-no-drag`}
                data-testid="agent-gui-config-footer"
              >
                {shouldShowProviderRailConfigMenu ? (
                  <AgentGUIConfigMenu
                    labels={labels}
                    previewMode={previewMode}
                    providerScopedActionsVisible={
                      viewModel.rail.conversationFilter.kind !== "all"
                    }
                    slashStatusLimits={effectiveRailSlashStatusLimits}
                    slashStatusLimitsLoading={slashStatusLimitsLoading}
                    slashStatusUsageCapturedAtUnixMs={
                      slashStatusUsageCapturedAtUnixMs
                    }
                    slashStatusUsageDidFail={slashStatusUsageDidFail}
                    slashStatusUsageAttempted={slashStatusUsageAttempted}
                    providerAuthAccountLabel={effectiveProviderAuthAccountLabel}
                    onAgentConfigMenuOpen={onAgentConfigMenuOpen}
                    onAgentUsageRefresh={onAgentUsageRefresh}
                    onOpenAgentManager={() => setProviderManagerOpen(true)}
                    onOpenAgentEnvSetup={openAgentEnvSetup}
                    onOpenAgentSettings={openAgentSettings}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={labels.agentSettingsMenu}
                    className={`${styles.providerRailConfigButton} nodrag tsh-desktop-no-drag`}
                    title={labels.agentSettingsMenu}
                    disabled={previewMode}
                    onClick={openAgentSettings}
                  >
                    <SettingsLinedIcon
                      aria-hidden="true"
                      width={18}
                      height={18}
                    />
                  </button>
                )}
              </div>
            ) : null}
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
          </aside>
        ) : null}
        <aside
          id="agent-gui-conversation-rail"
          className={`${styles.railPanel}${
            conversationRailCollapsed ? ` ${styles.railPanelCollapsed}` : ""
          }`}
          aria-hidden={conversationRailCollapsed ? "true" : undefined}
          inert={conversationRailCollapsed ? true : undefined}
        >
          <AgentGUIConversationRailPane
            {...conversationRailStoreState}
            conversations={viewModel.rail.conversations}
            userProjects={viewModel.rail.userProjects}
            workspaceId={viewModel.shell.workspaceId}
            footer={
              accountMenuState?.user ? (
                <AgentGUIAccountRailMenu
                  accountMenuState={accountMenuState}
                  labels={labels}
                  previewMode={previewMode}
                />
              ) : null
            }
          />
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
          <AgentGUIDetailPane
            viewModel={viewModel}
            actions={actions}
            labels={labels}
            uiLanguage={uiLanguage}
            hideDetailHeader={conversationRailCollapsed}
            isActive={isActive}
            workspaceReferencePickerOpen={workspaceReferencePickerOpen}
            composerFocusRequestSequence={detailComposerFocusRequestSequence}
            isAgentProviderReady={isAgentProviderReady}
            slashStatusLimits={slashStatusLimits}
            slashStatusLimitsLoading={slashStatusLimitsLoading}
            slashStatusLimitsUnavailable={slashStatusLimitsUnavailable}
            onSlashStatusOpen={onSlashStatusOpen}
            onLinkAction={onLinkAction}
            onHandoffConversation={onHandoffConversation}
            capabilityMenuState={capabilityMenuState}
            onCapabilitySettingsRequest={onCapabilitySettingsRequest}
            onAgentProviderLogin={onAgentProviderLogin}
            onRequestWorkspaceReferences={requestWorkspaceReferences}
            resolveDroppedFileReferences={resolveDroppedFileReferences}
            selectProjectDirectory={selectProjectDirectory}
            onRequestGitBranches={onRequestGitBranches}
            onRequestComposerFocus={requestComposerFocus}
            contextMentionProviders={contextMentionProviders}
            workspaceAppIcons={effectiveWorkspaceAppIcons}
            workspaceUserProjectI18n={workspaceUserProjectI18n}
            renderProviderUnavailableState={renderProviderUnavailableState}
            previewMode={previewMode}
          />
        </section>
      </div>
      {referenceSourceAggregator ? (
        <ReferenceSourcePicker
          aggregator={referenceSourceAggregator}
          copy={
            workspaceFileReferenceCopy ?? fallbackWorkspaceFileReferenceCopy
          }
          initialTarget={workspaceReferencePickerTarget}
          isNodeSelectable={isWorkspaceReferencePickerNodeSelectable}
          fileManagerCopy={workspaceFileManagerCopy ?? undefined}
          open={workspaceReferencePickerOpen}
          resolveEntryIconUrl={resolveWorkspaceReferenceEntryIconUrl}
          workspaceId={viewModel.shell.workspaceId}
          onClose={closeWorkspaceReferencePicker}
          onConfirm={confirmWorkspaceReferencePicker}
          onConfirmBundles={confirmWorkspaceReferenceBundles}
        />
      ) : (
        <WorkspaceFileReferencePicker
          copy={
            workspaceFileReferenceCopy ?? fallbackWorkspaceFileReferenceCopy
          }
          fileAdapter={workspaceFileReferenceAdapter ?? undefined}
          initialPath={viewModel.composer.composerSettings.selectedProjectPath}
          open={workspaceReferencePickerOpen}
          scoped
          workspaceId={viewModel.shell.workspaceId}
          onClose={closeWorkspaceReferencePicker}
          onConfirm={confirmWorkspaceReferencePicker}
        />
      )}
      <AgentGUIRenameConversationDialog
        conversation={renameConversationTarget}
        open={renameConversationDialogOpen && renameConversationTarget !== null}
        labels={labels}
        uiLanguage={uiLanguage}
        onOpenChange={(open) => {
          setRenameConversationDialogOpen(open);
          if (!open) {
            setRenameConversationTarget(null);
          }
        }}
        onRename={actions.renameConversation}
      />
    </AgentTargetPresentationProvider>
  );

  return previewMode ? content : <TooltipProvider>{content}</TooltipProvider>;
}
