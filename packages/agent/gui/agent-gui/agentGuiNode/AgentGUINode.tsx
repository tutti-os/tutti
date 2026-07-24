import { memo, useCallback, useMemo, useRef } from "react";
import { createWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { createWorkspaceFileManagerI18nRuntime } from "@tutti-os/workspace-file-manager";
import { useReferenceProvenanceFilterCatalog } from "@tutti-os/workspace-file-reference/react";
import type {
  ReferenceProvenanceCatalog,
  WorkspaceFileReference
} from "@tutti-os/workspace-file-reference/contracts";
import { useTranslation } from "../../i18n/index";
import type { WorkspaceLinkAction } from "../../actions/workspaceLinkActions";
import type { AgentGUINodeData } from "../../types";
import { resolveCanonicalNodeMinSize } from "../../utils/workspaceNodeSizing";
import { WorkspaceNodeWindow } from "../shared/WorkspaceNodeWindow";
import { CanvasNodeGhostIconButton } from "../shared/CanvasNodeGhostIconButton";
import { CanvasNodePanelLinedIcon } from "../shared/canvasNodeChromeIcons";
import { useAgentGUINodeController } from "./controller/useAgentGUINodeController";
import { useAgentGUIStatus } from "./controller/useAgentGUIStatus";
import { AgentGUINodeView } from "./AgentGUINodeView";
import {
  normalizeAgentGUIProviderIdentity,
  resolveAgentGUIProviderDisplayLabel
} from "./model/agentGuiProviderIdentity";
import { AgentProbeInfoPopover } from "../workspaceDesktop/view/AgentProbeInfoPopover";
import styles from "./AgentGUINode.styles";
import {
  AGENT_GUI_COLLAPSED_MIN_WIDTH_PX,
  AGENT_GUI_CONVERSATION_RAIL_MIN_WIDTH_PX,
  AGENT_GUI_DETAIL_MIN_WIDTH_PX,
  clampAgentGUIConversationRailWidthPx,
  resolveAgentGUIConversationRailPresentation,
  resolveAgentGUIExpandedWindowFrame,
  resolveNextAgentGUIConversationRailWidthPx,
  resolveAgentGUIConversationRailMaxWidthPx
} from "./model/agentGuiRailLayout";
import { resolveAgentGUIReferenceProvenanceFilterCatalog } from "./model/agentReferenceProvenanceCatalog";
import type { AgentGUINodeProps } from "./AgentGUINode.types";
import { areAgentGUINodePropsEqual } from "./AgentGUINode.types";
import { AgentGUIMentionServiceBoundary } from "./AgentGUIMentionServiceBoundary";
import {
  useAgentGUIViewLabels,
  useAgentGUIConversationRailLabels,
  useAgentGUIWorkspaceFileReferenceCopy
} from "./AgentGUINode.labels";

export type { AgentGUINodeProps } from "./AgentGUINode.types";

const DISABLED_REFERENCE_PROVENANCE_CATALOG: ReferenceProvenanceCatalog = {
  enabledDimensions: [],
  agentOptions: [],
  memberOptions: []
};

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
    resolveExternalPromptEntries = null,
    prepareExternalPromptFiles = null,
    promptAssetLimit = null,
    projectDirectorySourceAggregator = null,
    referenceSourceAggregator = null,
    resolveReferenceContentErrorAction:
      resolveWorkspaceReferenceContentErrorAction,
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
    isVisible = true,
    embedded = false,
    previewMode = false
  } = frame;
  const widthRef = useRef(width);
  widthRef.current = width;
  const {
    composerAppend: composerAppendRequest = null,
    composerFocusSequence: composerFocusRequestSequence = null,
    newConversationSequence: newConversationRequestSequence = null,
    sessionAction: sessionActionRequest = null,
    openSession: openSessionRequest = null,
    prefillPrompt: prefillPromptRequest = null,
    agentStatusController
  } = runtimeRequests;
  const {
    capabilityMenuState,
    capabilityControlsReadOnly = false,
    agentTargets,
    agentTargetsLoading = false,
    handoffAgentTargets,
    handoffAgentTargetsLoading = false,
    providerRailAllPresentation = null,
    providerRailMode = "catalog",
    comingSoonProviders,
    providerReadinessGates = null,
    targetConnectionSource = null,
    defaultAgentTargetId = null,
    providerAuthAccountLabels,
    mentionService,
    workspaceAppIcons,
    disabledHomeSuggestions,
    referenceProvenanceFilterCatalog: injectedReferenceProvenanceFilterCatalog,
    referenceProvenanceFilterEnabled = false
  } = hostCapabilities;
  const referenceProvenanceFilterCatalog =
    resolveAgentGUIReferenceProvenanceFilterCatalog({
      agentTargets,
      injectedCatalog: injectedReferenceProvenanceFilterCatalog,
      legacyAgentFilterEnabled: referenceProvenanceFilterEnabled
    });
  const referenceProvenanceFilterBinding = useReferenceProvenanceFilterCatalog(
    referenceProvenanceFilterCatalog ?? DISABLED_REFERENCE_PROVENANCE_CATALOG
  );
  const referenceProvenanceFilter =
    referenceProvenanceFilterBinding.snapshot.catalog.enabledDimensions.length >
    0
      ? referenceProvenanceFilterBinding
      : null;
  const {
    onLinkAction,
    onHandoffConversation,
    onCapabilitySettingsRequest,
    onAgentProviderLogin,
    onAgentEnvPanelOpen,
    onOpenConversationWindow,
    onClose,
    onResize,
    onUpdateNode,
    onRememberComposerDefaults,
    isMuted = false,
    onMinimize,
    onToggleMaximize,
    onShowMessage,
    onEngagementEvent,
    onConversationRailLayoutChange
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
      onLinkAction?.(action);
    },
    [onLinkAction]
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
          containerWidthPx: widthRef.current
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
    [onUpdateNode, previewMode]
  );
  const conversationRailPresentation =
    resolveAgentGUIConversationRailPresentation({
      containerWidthPx: width,
      conversationRailCollapsed: state.conversationRailCollapsed,
      conversationRailWidthPx: state.conversationRailWidthPx
    });
  const isConversationRailAutoCollapsed =
    conversationRailPresentation.isAutoCollapsed;
  const isConversationRailCollapsed = conversationRailPresentation.isCollapsed;
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
    composerAppendRequest,
    openSessionRequest,
    prefillPromptRequest,
    agentTargets,
    agentTargetsLoading,
    handoffAgentTargets,
    handoffAgentTargetsLoading,
    providerRailMode,
    comingSoonProviders,
    providerReadinessGates,
    targetConnectionSource,
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
  const selectedAgentTargetLabel =
    viewModel.rail.selectedAgentTarget?.label ??
    resolveAgentGUIProviderDisplayLabel(state.provider, fallbackAgentTitle);
  const displayProviderLabel = viewModel.rail.activeConversation
    ? resolveAgentGUIProviderDisplayLabel(activeProvider, fallbackAgentTitle)
    : selectedAgentTargetLabel;
  const conversationRailLabels = useAgentGUIConversationRailLabels(t);
  const labels = useAgentGUIViewLabels({
    disabledHomeSuggestions,
    displayProviderLabel,
    fallbackAgentTitle,
    t,
    workspaceAppIcons: workspaceAppIcons ?? [],
    workspaceId
  });
  const workspaceFileReferenceCopy = useAgentGUIWorkspaceFileReferenceCopy(t);
  const windowTitle = title;
  const {
    agentProbeLines,
    controllerRailStatus,
    handleAgentConfigMenuClose,
    handleAgentConfigMenuOpen,
    handleAgentProbeInfoClose,
    handleAgentProbeInfoOpen,
    handleAgentUsageRefresh,
    handleSlashStatusClose,
    handleSlashStatusOpen,
    handleSlashStatusRefresh,
    railStatusProvider,
    slashStatusLimits,
    slashStatusLimitsUnavailable,
    slashStatusOverride
  } = useAgentGUIStatus({
    activeProvider,
    agentStatusController,
    previewMode,
    t,
    viewModel
  });

  return (
    <AgentGUIMentionServiceBoundary service={mentionService}>
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
              onClose={handleAgentProbeInfoClose}
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
            resolveAgentGUIConversationRailPresentation({
              containerWidthPx: renderedWidth,
              conversationRailCollapsed: state.conversationRailCollapsed,
              conversationRailWidthPx: state.conversationRailWidthPx
            }).isCollapsed;

          return (
            <AgentGUINodeView
              viewModel={viewModel}
              renderSidebarFooter={renderSidebarFooter}
              renderProviderRailEmpty={renderProviderRailEmpty}
              renderProviderUnavailableState={renderProviderUnavailableState}
              providerRailAllPresentation={providerRailAllPresentation}
              actions={viewActions}
              isActive={isActive}
              isVisible={isVisible}
              onEngagementEvent={onEngagementEvent}
              composerFocusRequestSequence={composerFocusRequestSequence}
              newConversationRequestSequence={newConversationRequestSequence}
              sessionActionRequest={sessionActionRequest}
              slashStatusLimits={slashStatusLimits}
              slashStatusLimitsLoading={controllerRailStatus?.loading ?? false}
              slashStatusLimitsUnavailable={slashStatusLimitsUnavailable}
              slashStatusOverride={slashStatusOverride}
              railConfigProvider={railStatusProvider}
              railSlashStatusLimits={controllerRailStatus?.limits ?? []}
              slashStatusUsageCapturedAtUnixMs={
                controllerRailStatus?.capturedAtUnixMs ?? null
              }
              slashStatusUsageDidFail={controllerRailStatus?.didFail ?? false}
              slashStatusUsageAttempted={
                controllerRailStatus?.attempted ?? false
              }
              slashStatusLimitsResolvedEmpty={
                controllerRailStatus?.resolvedEmpty ?? false
              }
              providerAuthAccountLabels={providerAuthAccountLabels}
              onAgentConfigMenuClose={handleAgentConfigMenuClose}
              onAgentConfigMenuOpen={handleAgentConfigMenuOpen}
              onAgentUsageRefresh={handleAgentUsageRefresh}
              onSlashStatusOpen={handleSlashStatusOpen}
              onSlashStatusClose={handleSlashStatusClose}
              onSlashStatusRefresh={handleSlashStatusRefresh}
              previewMode={previewMode}
              onLinkAction={handleLinkAction}
              onHandoffConversation={onHandoffConversation}
              capabilityMenuState={capabilityMenuState}
              capabilityControlsReadOnly={capabilityControlsReadOnly}
              onCapabilitySettingsRequest={onCapabilitySettingsRequest}
              onAgentProviderLogin={
                onAgentProviderLogin ? handleAgentProviderLogin : undefined
              }
              onAgentEnvPanelOpen={onAgentEnvPanelOpen}
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
              resolveExternalPromptEntries={resolveExternalPromptEntries}
              prepareExternalPromptFiles={prepareExternalPromptFiles}
              promptAssetLimit={promptAssetLimit}
              onConversationRailWidthChanged={
                handleConversationRailWidthChanged
              }
              onConversationRailLayoutChange={onConversationRailLayoutChange}
              labels={labels}
              conversationRailLabels={conversationRailLabels}
              workspaceUserProjectI18n={workspaceUserProjectI18n}
              workspaceFileManagerCopy={workspaceFileManagerI18n}
              workspaceFileReferenceAdapter={workspaceFileReferenceAdapter}
              onOpenConversationWindow={onOpenConversationWindow}
              onRequestGitBranches={onRequestGitBranches}
              selectProjectDirectory={selectProjectDirectory}
              projectDirectorySourceAggregator={
                projectDirectorySourceAggregator
              }
              referenceSourceAggregator={referenceSourceAggregator}
              resolveReferenceContentErrorAction={
                resolveWorkspaceReferenceContentErrorAction
              }
              resolveWorkspaceReferenceEntryIconUrl={
                resolveWorkspaceReferenceEntryIconUrl
              }
              resolveMentionReferenceTarget={resolveMentionReferenceTarget}
              resolveWorkspaceReferenceInitialTarget={
                resolveWorkspaceReferenceInitialTarget
              }
              workspaceFileReferenceCopy={workspaceFileReferenceCopy}
              workspaceAppIcons={workspaceAppIcons}
              referenceProvenanceFilter={referenceProvenanceFilter}
            />
          );
        }}
      </WorkspaceNodeWindow>
    </AgentGUIMentionServiceBoundary>
  );
}, areAgentGUINodePropsEqual);
