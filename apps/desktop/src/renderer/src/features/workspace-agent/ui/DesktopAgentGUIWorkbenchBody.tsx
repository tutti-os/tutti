import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { AgentGUI } from "@tutti-os/agent-gui/agent-gui";
import {
  type AgentGUIProps,
  type AgentGUISessionLaunchMode,
  type AgentHostInputApi,
  type AgentVisibleErrorOverrides
} from "@tutti-os/agent-gui";
import { resolveInsufficientCreditsSemantic } from "@tutti-os/commerce";
import { useService } from "@tutti-os/infra/di";
import { requestWorkspaceAgentGuiLaunch } from "../services/workspaceAgentGuiLaunchCoordinator.ts";
import { registerWorkspaceAgentGuiOpenSession } from "../../workspace-workbench/services/workspaceAgentGuiOpenSessionCoordinator.ts";
import {
  selectWorkbenchNodeIsVisuallyExposed,
  useWorkbenchSelector,
  useWorkbenchVisualOcclusionPresentation,
  workbenchFocusInputActivationType
} from "@tutti-os/workbench-surface";
import { useTranslation } from "@renderer/i18n";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { buildDesktopCommerceErrorPresentation } from "./desktopCommerceErrorPresentation";
import { Toast } from "@renderer/lib/toast";
import { isDesktopAgentProvider } from "@shared/preferences";
import {
  areDesktopAgentGUINodeStatesEqual,
  areDesktopAgentGUIWorkbenchStatesEqual,
  desktopAgentGUIPrefillPromptActivationType,
  normalizeDesktopAgentGUIProvider,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState
} from "../desktopAgentGUINodeState";
import { consumeDesktopAgentGUIOpenSessionActivation } from "../services/desktopAgentGUIOpenSessionActivation.ts";
import type { DesktopAgentGUIOpenSessionComposerRequest } from "../services/desktopAgentGUIOpenSessionComposerActivation.ts";
import {
  consumeDesktopAgentGUIPrefillPromptActivation,
  type DesktopAgentGUIPrefillPromptRequest
} from "../services/desktopAgentGUIPrefillPromptActivation.ts";
import { logAgentComposerDefaultsDiagnostic } from "./desktopAgentGUIWorkbenchDiagnostics.ts";
import {
  hasDesktopAgentGUIConversationRailCollapsedState,
  resolveDesktopAgentGUIProviderForAgentTarget
} from "./desktopAgentGUIWorkbenchStateHelpers.ts";
import {
  DESKTOP_AGENT_GUI_AGENT_SETTINGS,
  DESKTOP_AGENT_GUI_NOOP,
  DESKTOP_AGENT_GUI_POSITION,
  areDesktopAgentGUIWorkbenchBodyPropsEqual,
  handleDesktopAgentGUIShowMessage,
  resolveComputerUseAuthorizationState,
  type DesktopAgentGUISurfaceContext,
  type DesktopAgentGUISurfaceProps,
  type DesktopAgentGUIWorkbenchBodyProps
} from "./desktopAgentGUIWorkbenchModel.ts";
import { useDesktopAgentStatusController } from "./useDesktopAgentStatusController.ts";
import { useDesktopAgentGUIContextMentions } from "./useDesktopAgentGUIContextMentions.ts";
import { useDesktopAgentGUIReadiness } from "./useDesktopAgentGUIReadiness.ts";
import { useDesktopAgentGUIOpenConversationWindow } from "./useDesktopAgentGUIOpenConversationWindow.ts";
import { useStableDesktopAgentGUIHostProps } from "./useStableDesktopAgentGUIHostProps.ts";
import { resolveDesktopAgentGUIEmbeddedDesktopSize } from "./desktopAgentGUIEmbeddedFrame.ts";
import { scheduleDesktopAgentGUIWorkbenchHydration } from "./desktopAgentGUIWorkbenchHydration.ts";
import { resolveDesktopAgentGUIWorkbenchBodyVisibility } from "./desktopAgentGUIWorkbenchVisibility.ts";
import { useDesktopAgentConfigCommerce } from "./useDesktopAgentConfigCommerce.tsx";
import { hasDesktopLocalTuttiAgent } from "./desktopAgentConfigCommerceContext.ts";
import { useDesktopAgentGUIComposerFooterAccessory } from "./useDesktopAgentGUIComposerFooterAccessory.tsx";
import { useDesktopAgentGUIOpenSessionComposerRequest } from "./useDesktopAgentGUIOpenSessionComposerRequest.ts";
import { useDesktopAgentGUIProviderAuthAccountLabels } from "./useDesktopAgentGUIProviderAuthAccountLabels.ts";
import {
  useDesktopAgentGUIConversationRailPreference,
  useDesktopAgentGUIConversationRailToggle
} from "./useDesktopAgentGUIConversationRailPreference.ts";
import { useDesktopAgentGUISessionLaunchModePreference } from "./useDesktopAgentGUISessionLaunchModePreference.ts";
import { IAgentEnvService } from "../services/agentEnvService.interface.ts";
import { preloadDesktopAgentGuiMentionBrowse } from "../services/preloadDesktopAgentGuiMentionBrowse.ts";
import { DESKTOP_AGENT_GUI_CURRENT_USER_ID } from "../services/desktopAgentGuiIdentity.ts";
import {
  AGENT_SESSION_RECORDING_FLAG,
  AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
  LAB_CONVERSATION_ACTIVITY_VIEW_FLAG,
  isFeatureEnabled,
  LAB_AGENT_SIDE_CONVERSATION_FLAG,
  LAB_CODEX_SAVER_MODE_FLAG,
  LAB_CONNECTORS_FLAG
} from "../../../../../shared/featureFlags/catalog.ts";

const EMPTY_AGENT_SESSION_LAUNCH_MODES_BY_PROJECT_SECTION_KEY: Readonly<
  Record<string, AgentGUISessionLaunchMode>
> = Object.freeze({});

const AgentSessionReplayNodeReadiness = lazy(() =>
  import("../../agent-session-replay/ui/AgentSessionReplayNodeReadiness.tsx").then(
    (module) => ({ default: module.AgentSessionReplayNodeReadiness })
  )
);

function DesktopAgentGUISurfaceImpl({
  agentActivityRuntime: hostAgentActivityRuntime,
  agentSideConversationRuntime = null,
  agentHostApi,
  agentSessionReplayService,
  agentStatusSource,
  tuttiModePlanReviewRuntime,
  appCenterService,
  agentProviderStatusService,
  surface,
  computerUseApi,
  composerAppendRequest = null,
  dockPreviewCache,
  onLinkAction,
  onCapabilitySettingsRequest,
  onOpenAgentConversationWindow,
  onStateChange,
  prefillPromptBootstrapRequest = null,
  providerStatusBootstrapSnapshot = null,
  agentDirectory,
  allAgentsPresentation = null,
  renderAgentsEmpty,
  comingSoonAgentProviders,
  defaultAgentTargetId = null,
  contextMentionProviders,
  runtimeApi,
  trackAgentProviderChatReady,
  onEngagementEvent,
  onConversationRailLayoutChange,
  trackWorkspaceFileReferences,
  workspaceFileReferenceAdapter,
  resolveExternalPromptEntries,
  prepareExternalPromptFiles,
  onRequestGitBranches,
  referenceSourceAggregator,
  renderSidebarFooter,
  resolveWorkspaceReferenceEntryIconUrl,
  resolveMentionReferenceTarget,
  resolveWorkspaceReferenceInitialTarget,
  workspaceId
}: DesktopAgentGUISurfaceProps): JSX.Element {
  const agents = agentDirectory.agents;
  const replayRuntimeActive =
    runtimeApi?.isAgentSessionReplayRuntime?.() === true;
  const { i18n, locale } = useTranslation();
  const commerceEnabled = hasDesktopLocalTuttiAgent(agents);
  const { accountState, handleAgentConfigMenuOpen, renderAgentConfigAccount } =
    useDesktopAgentConfigCommerce(commerceEnabled);
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const agentActivityRuntime = useMemo<
    AgentGUIProps["agentActivityRuntime"]
  >(() => {
    const activityViewEnabled =
      hostAgentActivityRuntime.conversationActivityViewEnabled === true &&
      isFeatureEnabled(
        desktopPreferencesState.featureFlags,
        LAB_CONVERSATION_ACTIVITY_VIEW_FLAG
      );
    if (
      hostAgentActivityRuntime.conversationActivityViewEnabled ===
      activityViewEnabled
    ) {
      return hostAgentActivityRuntime;
    }
    return {
      ...hostAgentActivityRuntime,
      conversationActivityViewEnabled: activityViewEnabled
    };
  }, [desktopPreferencesState.featureFlags, hostAgentActivityRuntime]);
  const rawWorkbenchState = normalizeDesktopAgentGUIWorkbenchState(
    surface.state
  );
  const requestedAgentTargetId =
    rawWorkbenchState.agentTargetId?.trim() || defaultAgentTargetId;
  const readinessProvider =
    agents.find((agent) => agent.agentTargetId === requestedAgentTargetId)
      ?.provider ?? null;
  const agentEnvService = useService(IAgentEnvService);
  const visibleErrorPresentationOverrides =
    useMemo<AgentVisibleErrorOverrides | null>(() => {
      if (!commerceEnabled) {
        return null;
      }
      const summary = accountState.productSummary;
      return buildDesktopCommerceErrorPresentation({
        semantic: resolveInsufficientCreditsSemantic(summary?.membership_access)
          .message,
        actionUrl: summary?.links.plan_url,
        copy: {
          upgradeMembership: {
            message: i18n.t(
              "workspace.accountMenu.insufficientCreditsUpgradeMessage"
            ),
            actionLabel: i18n.t("workspace.accountMenu.upgradeMembership")
          },
          rechargeCredits: {
            message: i18n.t(
              "workspace.accountMenu.insufficientCreditsRechargeMessage"
            ),
            actionLabel: i18n.t("workspace.accountMenu.rechargeCredits")
          },
          creditsUnavailable: {
            message: i18n.t(
              "workspace.accountMenu.insufficientCreditsUnknownMessage"
            ),
            actionLabel: i18n.t("workspace.accountMenu.viewCreditPlans")
          }
        }
      });
    }, [accountState.productSummary, i18n, commerceEnabled]);
  const {
    computerUseStatus,
    handleAgentProviderLogin,
    provider,
    providerReadinessGates,
    providerStatusSnapshot
  } = useDesktopAgentGUIReadiness({
    agentActivityRuntime,
    agentProviderStatusService,
    computerUseApi,
    host: surface.host,
    provider: readinessProvider,
    providerStatusBootstrapSnapshot,
    trackAgentProviderChatReady,
    workspaceId
  });
  const {
    effectiveContextMentionProviders,
    mentionService,
    workspaceAppIcons
  } = useDesktopAgentGUIContextMentions({
    agentActivityRuntime,
    appCenterService,
    contextMentionProviders,
    dockPreviewCache,
    host: surface.host,
    workspaceId
  });
  useEffect(() => {
    preloadDesktopAgentGuiMentionBrowse({
      agentActivityRuntime,
      baseProviders: effectiveContextMentionProviders,
      workspaceId
    });
  }, [agentActivityRuntime, effectiveContextMentionProviders, workspaceId]);
  // Pin the host's defensive state copy so downstream work tracks real changes.
  const workbenchStateRef = useRef(rawWorkbenchState);
  if (
    !areDesktopAgentGUIWorkbenchStatesEqual(
      workbenchStateRef.current,
      rawWorkbenchState
    )
  ) {
    workbenchStateRef.current = rawWorkbenchState;
  }
  const workbenchState = workbenchStateRef.current;
  const workbenchAgentTargetId = workbenchState.agentTargetId?.trim() || null;
  const nodeProvider = useMemo(
    () =>
      resolveDesktopAgentGUIProviderForAgentTarget(
        workbenchAgentTargetId,
        agents,
        provider ?? "unknown"
      ),
    [agents, provider, workbenchAgentTargetId]
  );
  const hasExplicitConversationRailCollapsedState =
    hasDesktopAgentGUIConversationRailCollapsedState(surface.state);
  const preferredConversationRailCollapsed =
    isDesktopAgentProvider(nodeProvider) &&
    desktopPreferencesState.agentGuiConversationRailCollapsedByProvider[
      nodeProvider
    ] === true;
  // Persisted composer defaults are read through target-scoped composer
  // options. Workbench state only carries the local draft and session route.
  const nodeState = useMemo(() => {
    const baseState = normalizeDesktopAgentGUINodeState(
      workbenchState,
      nodeProvider
    );
    const railState =
      !hasExplicitConversationRailCollapsedState &&
      preferredConversationRailCollapsed
        ? { ...baseState, conversationRailCollapsed: true }
        : baseState;
    return railState;
  }, [
    hasExplicitConversationRailCollapsedState,
    preferredConversationRailCollapsed,
    workbenchState,
    nodeProvider
  ]);
  const nodeStateRef = useRef(nodeState);
  nodeStateRef.current = nodeState;
  // Lets the waiting-decision toast know this session's conversation is
  // already visible, so it can skip a redundant in-app interruption.
  useEffect(() => {
    const agentSessionId = workbenchState.lastActiveAgentSessionId?.trim();
    if (!agentSessionId || surface.isMinimized) {
      return undefined;
    }
    return registerWorkspaceAgentGuiOpenSession(workspaceId, agentSessionId);
  }, [
    surface.isMinimized,
    workbenchState.lastActiveAgentSessionId,
    workspaceId
  ]);
  const [openSessionRequest, setOpenSessionRequest] = useState<NonNullable<
    AgentGUIProps["runtimeRequests"]["openSession"]
  > | null>(null);
  const [openSessionComposerRequest, setOpenSessionComposerRequest] =
    useState<DesktopAgentGUIOpenSessionComposerRequest | null>(null);
  const [prefillPromptRequest, setPrefillPromptRequest] =
    useState<DesktopAgentGUIPrefillPromptRequest | null>(
      () => prefillPromptBootstrapRequest
    );
  const handledOpenSessionActivationSequenceRef = useRef<number | null>(null);
  const handledPrefillPromptActivationSequenceRef = useRef<number | null>(null);
  // onStateChange is recreated on every host render; pin it so the writer stays
  // referentially stable and effects don't resubscribe each render.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const rememberConversationRailPreference =
    useDesktopAgentGUIConversationRailPreference({
      desktopPreferencesService,
      runtimeApi,
      workspaceId
    });
  const sessionLaunchModesByProjectSectionKey =
    desktopPreferencesState.agentSessionLaunchModesByWorkspace[workspaceId] ??
    EMPTY_AGENT_SESSION_LAUNCH_MODES_BY_PROJECT_SECTION_KEY;
  const handleSessionLaunchModePreferenceChange =
    useDesktopAgentGUISessionLaunchModePreference({
      desktopPreferencesService,
      runtimeApi,
      workspaceId
    });
  // The only writer persists when the projected workbench state changes.
  const handleUpdateNode = useCallback(
    (
      updater: (current: DesktopAgentGUINodeState) => DesktopAgentGUINodeState
    ) => {
      const current = nodeStateRef.current;
      const next = normalizeDesktopAgentGUINodeState(
        updater(current),
        nodeProvider
      );
      if (areDesktopAgentGUINodeStatesEqual(current, next)) {
        return;
      }
      nodeStateRef.current = next;
      const previousRailCollapsed = current.conversationRailCollapsed === true;
      const nextRailCollapsed = next.conversationRailCollapsed === true;
      if (previousRailCollapsed !== nextRailCollapsed) {
        rememberConversationRailPreference(next.provider, nextRailCollapsed);
      }
      const nextWorkbenchState = projectDesktopAgentGUIWorkbenchState(next);
      if (
        !areDesktopAgentGUIWorkbenchStatesEqual(
          projectDesktopAgentGUIWorkbenchState(current),
          nextWorkbenchState
        )
      ) {
        onStateChangeRef.current(nextWorkbenchState);
      }
    },
    [nodeProvider, rememberConversationRailPreference]
  );
  const handleWorkbenchConversationRailToggle =
    useDesktopAgentGUIConversationRailToggle({
      nodeStateRef,
      rememberConversationRailPreference,
      stateOwner: surface.conversationRailStateOwner,
      updateNode: handleUpdateNode
    });
  const agentStatusController = useDesktopAgentStatusController(
    {
      agentActivityRuntime,
      agents,
      workspaceAgentProbes: agentHostApi.workspaceAgentProbes,
      workspaceId
    },
    agentStatusSource
  );
  useEffect(() => {
    if (!provider) {
      return;
    }
    consumeDesktopAgentGUIOpenSessionActivation({
      activation: surface.activation,
      agentActivityRuntime,
      clearNodeActivation: surface.host.clearNodeActivation?.bind(surface.host),
      handledSequence: handledOpenSessionActivationSequenceRef.current,
      markHandled: (sequence) => {
        handledOpenSessionActivationSequenceRef.current = sequence;
      },
      nodeId: surface.nodeId,
      onOpenSessionRequest: setOpenSessionRequest,
      onOpenSessionComposerRequest: setOpenSessionComposerRequest,
      // Persistence is owned by handleUpdateNode (the single writer).
      onStateChange: DESKTOP_AGENT_GUI_NOOP,
      provider,
      resolveAgentTargetProvider: (agentTargetId) =>
        resolveDesktopAgentGUIProviderForAgentTarget(
          agentTargetId,
          agents,
          provider
        ),
      workspaceId,
      updateNodeState: handleUpdateNode
    });
  }, [
    agentActivityRuntime,
    surface.activation,
    surface.host,
    surface.nodeId,
    handleUpdateNode,
    provider,
    agents,
    workspaceId
  ]);

  useEffect(() => {
    const request = consumeDesktopAgentGUIPrefillPromptActivation({
      activation: surface.activation,
      clearNodeActivation: surface.host.clearNodeActivation?.bind(surface.host),
      handledSequence: handledPrefillPromptActivationSequenceRef.current,
      markHandled: (sequence) => {
        handledPrefillPromptActivationSequenceRef.current = sequence;
      },
      nodeId: surface.nodeId
    });
    if (request) {
      if (request.agentTargetId || request.provider) {
        handleUpdateNode((current) => ({
          ...current,
          agentTargetId: request.agentTargetId ?? current.agentTargetId ?? null,
          lastActiveAgentSessionId: null,
          provider: request.provider ?? current.provider
        }));
      } else {
        handleUpdateNode((current) =>
          current.lastActiveAgentSessionId === null
            ? current
            : {
                ...current,
                lastActiveAgentSessionId: null
              }
        );
      }
      setPrefillPromptRequest(request);
    }
  }, [surface.activation, surface.host, surface.nodeId, handleUpdateNode]);

  const handleOpenConversationWindow = useDesktopAgentGUIOpenConversationWindow(
    {
      agentTargetId: workbenchAgentTargetId,
      onOpenAgentConversationWindow,
      provider: nodeProvider,
      workspaceId
    }
  );

  useEffect(() => {
    if (
      hasExplicitConversationRailCollapsedState ||
      !preferredConversationRailCollapsed
    ) {
      return;
    }
    const seededState = normalizeDesktopAgentGUINodeState(
      {
        ...nodeState,
        conversationRailCollapsed: true
      },
      nodeProvider
    );
    const nextWorkbenchState =
      projectDesktopAgentGUIWorkbenchState(seededState);
    if (
      !areDesktopAgentGUIWorkbenchStatesEqual(
        workbenchState,
        nextWorkbenchState
      )
    ) {
      onStateChangeRef.current(nextWorkbenchState);
    }
  }, [
    hasExplicitConversationRailCollapsedState,
    nodeState,
    nodeProvider,
    preferredConversationRailCollapsed,
    workbenchState
  ]);

  const handleRememberComposerDefaults = useCallback<
    NonNullable<AgentGUIProps["hostActions"]["onRememberComposerDefaults"]>
  >(
    ({ agentTargetId, provider: defaultsProvider, defaults }) => {
      // Remembered defaults are keyed strictly by agent target; targets
      // without an agentTargetId (legacy refs) are not persisted.
      if (!agentTargetId || !defaults) {
        return;
      }
      return desktopPreferencesService
        .rememberAgentComposerDefaultsForAgentTarget(agentTargetId, defaults)
        .catch((error) => {
          logAgentComposerDefaultsDiagnostic({
            agentTargetId,
            error,
            provider: defaultsProvider,
            runtimeApi,
            workspaceId
          });
          throw error;
        });
    },
    [desktopPreferencesService, runtimeApi, workspaceId]
  );
  const handleComposerAppendHandled =
    useDesktopAgentGUIOpenSessionComposerRequest(setOpenSessionComposerRequest);

  const frame = surface.frame;
  const agentHostApiWithToast = useMemo<AgentHostInputApi>(
    () => ({
      ...agentHostApi,
      toast: {
        error: Toast.Error,
        info: Toast.tips,
        loading: Toast.Loading,
        success: Toast.Success
      }
    }),
    [agentHostApi]
  );
  const desktopSize = useMemo(
    () => resolveDesktopAgentGUIEmbeddedDesktopSize(frame),
    [frame.height, frame.width]
  );
  const composerFocusRequestSequence =
    openSessionComposerRequest?.sequence ??
    composerAppendRequest?.sequence ??
    (surface.activation?.type === workbenchFocusInputActivationType ||
    surface.activation?.type === desktopAgentGUIPrefillPromptActivationType
      ? surface.activation.sequence
      : (prefillPromptRequest?.sequence ?? null));
  const capabilityMenuState = useMemo<
    AgentGUIProps["hostCapabilities"]["capabilityMenuState"]
  >(() => {
    const featureFlags =
      desktopPreferencesState.changingFeatureFlags ??
      desktopPreferencesState.featureFlags;
    return {
      browserUse: {
        connectionMode: desktopPreferencesState.browserUseConnectionMode
      },
      computerUse: {
        authorization: resolveComputerUseAuthorizationState(computerUseStatus),
        installed: computerUseStatus?.installed ?? null,
        presentationSupported: true
      },
      connectors: {
        enabled: isFeatureEnabled(featureFlags, LAB_CONNECTORS_FLAG)
      },
      tuttiMode: {
        enabled: true
      }
    };
  }, [
    computerUseStatus,
    desktopPreferencesState.browserUseConnectionMode,
    desktopPreferencesState.changingFeatureFlags,
    desktopPreferencesState.featureFlags
  ]);
  const handleAgentEnvPanelOpen = useCallback<
    NonNullable<AgentGUIProps["hostActions"]["onAgentEnvPanelOpen"]>
  >((input) => agentEnvService.open(input), [agentEnvService]);
  const referenceProvenanceFilterEnabled = isFeatureEnabled(
    desktopPreferencesState.featureFlags,
    AGENT_REFERENCE_PROVENANCE_FILTER_FLAG
  );
  const sessionInputHistoryEnabled = true;
  const sideConversationEnabled = isFeatureEnabled(
    desktopPreferencesState.changingFeatureFlags ??
      desktopPreferencesState.featureFlags,
    LAB_AGENT_SIDE_CONVERSATION_FLAG
  );
  const codexSaverModeEntryEnabled = isFeatureEnabled(
    desktopPreferencesState.featureFlags,
    LAB_CODEX_SAVER_MODE_FLAG
  );
  const providerAuthAccountLabels = useDesktopAgentGUIProviderAuthAccountLabels(
    providerStatusSnapshot.statuses
  );
  const handleHandoffConversation = useCallback<
    NonNullable<AgentGUIProps["hostActions"]["onHandoffConversation"]>
  >(
    async (request) => {
      await requestWorkspaceAgentGuiLaunch({
        agentTargetId: request.agentTargetId,
        draftPrompt: request.draftPrompt,
        openInNewWindow: true,
        provider: normalizeDesktopAgentGUIProvider(request.provider),
        userProjectPath: request.userProjectPath,
        workspaceId
      });
    },
    [workspaceId]
  );
  const sessionRecordingEnabled =
    isFeatureEnabled(
      desktopPreferencesState.featureFlags,
      AGENT_SESSION_RECORDING_FLAG
    ) && agentSessionReplayService !== null;
  const renderComposerFooterAccessory =
    useDesktopAgentGUIComposerFooterAccessory({
      agentSessionReplayService,
      nodeId: surface.nodeId,
      runtimeApi,
      sessionRecordingEnabled,
      workspaceId
    });
  const agentGUIHostProps = useStableDesktopAgentGUIHostProps({
    identity: {
      nodeId: surface.nodeId,
      workspaceId,
      currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID,
      title: surface.nodeTitle
    },
    workspace: {
      path: "",
      fileReferenceAdapter: workspaceFileReferenceAdapter,
      onRequestGitBranches: onRequestGitBranches,
      selectProjectDirectory: agentHostApi.workspace.selectDirectory,
      resolveExternalPromptEntries: resolveExternalPromptEntries,
      prepareExternalPromptFiles: prepareExternalPromptFiles,
      promptAssetLimit: 16,
      referenceSourceAggregator: referenceSourceAggregator,
      resolveReferenceEntryIconUrl: resolveWorkspaceReferenceEntryIconUrl,
      resolveMentionReferenceTarget: resolveMentionReferenceTarget,
      resolveReferenceInitialTarget: resolveWorkspaceReferenceInitialTarget,
      onFileReferencesAdded: trackWorkspaceFileReferences,
      agentSettings: DESKTOP_AGENT_GUI_AGENT_SETTINGS
    },
    runtimeRequests: {
      composerAppend: openSessionComposerRequest
        ? {
            agentSessionId: openSessionComposerRequest.agentSessionId,
            prompt: openSessionComposerRequest.draftPrompt,
            sequence: openSessionComposerRequest.sequence
          }
        : composerAppendRequest,
      composerFocusSequence: composerFocusRequestSequence,
      workbench: {
        instanceId: surface.instanceId,
        onConversationRailToggle: handleWorkbenchConversationRailToggle
      },
      openSession: openSessionRequest,
      prefillPrompt: prefillPromptRequest,
      agentStatusController: agentStatusController
    },
    hostCapabilities: {
      referenceProvenanceFilterEnabled,
      sideConversationEnabled,
      sessionInputHistoryEnabled,
      sessionWorktreeEnabled: true,
      sessionLaunchModesByProjectSectionKey,
      codexSaverModeEntryEnabled,
      capabilityMenuState,
      visibleErrorPresentationOverrides,
      comingSoonProviders: comingSoonAgentProviders,
      providerReadinessGates,
      defaultAgentTargetId,
      providerAuthAccountLabels,
      mentionService,
      workspaceAppIcons
    },
    hostActions: {
      onComposerAppendHandled: handleComposerAppendHandled,
      onAgentEnvPanelOpen: handleAgentEnvPanelOpen,
      onAgentConfigMenuOpen: handleAgentConfigMenuOpen,
      onAgentProviderLogin: agentProviderStatusService
        ? handleAgentProviderLogin
        : undefined,
      onCapabilitySettingsRequest: onCapabilitySettingsRequest,
      onClose: DESKTOP_AGENT_GUI_NOOP,
      onLinkAction: onLinkAction,
      onHandoffConversation: handleHandoffConversation,
      onResize: DESKTOP_AGENT_GUI_NOOP,
      onShowMessage: handleDesktopAgentGUIShowMessage,
      onUpdateNode: handleUpdateNode,
      onRememberComposerDefaults: handleRememberComposerDefaults,
      onSessionLaunchModePreferenceChange:
        handleSessionLaunchModePreferenceChange,
      onEngagementEvent: onEngagementEvent,
      onConversationRailLayoutChange,
      onOpenConversationWindow: !onOpenAgentConversationWindow
        ? undefined
        : handleOpenConversationWindow
    },
    renderSlots: {
      agentConfigAccount: renderAgentConfigAccount,
      composerFooterAccessory: renderComposerFooterAccessory,
      sidebarFooter: renderSidebarFooter
    }
  });

  return (
    <>
      {replayRuntimeActive ? (
        <Suspense fallback={null}>
          <AgentSessionReplayNodeReadiness
            agentActivityRuntime={agentActivityRuntime}
            nodeId={surface.nodeId}
            selectedAgentSessionId={
              workbenchState.lastActiveAgentSessionId?.trim() || null
            }
            workspaceId={workspaceId}
          />
        </Suspense>
      ) : null}
      <AgentGUI
        agentDirectory={agentDirectory}
        allAgentsPresentation={allAgentsPresentation}
        renderAgentsEmpty={renderAgentsEmpty}
        agentActivityRuntime={agentActivityRuntime}
        agentSideConversationRuntime={
          sideConversationEnabled ? agentSideConversationRuntime : null
        }
        agentHostApi={agentHostApiWithToast}
        disabled={["clone-github-repository"]}
        tuttiModePlanReviewRuntime={
          capabilityMenuState?.tuttiMode?.enabled === false
            ? null
            : tuttiModePlanReviewRuntime
        }
        i18n={i18n}
        locale={locale}
        identity={agentGUIHostProps.identity}
        workspace={agentGUIHostProps.workspace}
        frame={{
          conversationRailAutoCollapseMode:
            surface.conversationRailAutoCollapseMode,
          position: DESKTOP_AGENT_GUI_POSITION,
          width: frame.width,
          height: frame.height,
          desktopSize,
          isMaximized: surface.displayMode === "fullscreen",
          isActive: surface.isFocused,
          isVisible: surface.isVisible,
          embedded: true
        }}
        state={nodeState}
        runtimeRequests={agentGUIHostProps.runtimeRequests}
        hostCapabilities={agentGUIHostProps.hostCapabilities}
        hostActions={agentGUIHostProps.hostActions}
        renderSlots={agentGUIHostProps.renderSlots}
      />
    </>
  );
}

export const DesktopAgentGUISurface = DesktopAgentGUISurfaceImpl;

function DesktopAgentGUIWorkbenchBodyAdapter({
  context,
  ...props
}: DesktopAgentGUIWorkbenchBodyProps): JSX.Element {
  const visualOcclusionPresentation = useWorkbenchVisualOcclusionPresentation();
  const isVisuallyExposed = useWorkbenchSelector((state) =>
    selectWorkbenchNodeIsVisuallyExposed(
      state,
      context.node.id,
      visualOcclusionPresentation
    )
  );
  const isBodyVisible = resolveDesktopAgentGUIWorkbenchBodyVisibility({
    isPresentationVisible: context.isPresentationVisible,
    isVisible: context.isVisible,
    isVisuallyExposed
  });
  const [bodyHydrated, setBodyHydrated] = useState(
    context.isFocused || isBodyVisible
  );
  useEffect(() => {
    if (bodyHydrated || context.isFocused || isBodyVisible) {
      if (!bodyHydrated) {
        setBodyHydrated(true);
      }
      return;
    }
    return scheduleDesktopAgentGUIWorkbenchHydration(() => {
      setBodyHydrated(true);
    });
  }, [bodyHydrated, context.isFocused, isBodyVisible]);
  if (!bodyHydrated && !context.isFocused && !isBodyVisible) {
    return (
      <div
        aria-hidden="true"
        className="size-full bg-[var(--background-panel)]"
        data-agent-gui-workbench-hydration="pending"
      />
    );
  }
  const surface: DesktopAgentGUISurfaceContext = {
    activation: context.activation,
    conversationRailStateOwner: "workbench-node-source",
    displayMode: context.displayMode,
    frame: context.node.frame,
    host: context.host,
    instanceId: context.instanceId,
    isDragging: context.isDragging,
    isFocused: context.isFocused,
    isMinimized: context.node.isMinimized === true,
    isResizing: context.isResizing,
    isVisible: isBodyVisible,
    nodeId: context.node.id,
    nodeTitle: context.node.title,
    presentationMode: context.presentationMode,
    state:
      context.externalNodeState ?? context.node.data.runtimeNodeState ?? null
  };
  return <DesktopAgentGUISurface {...props} surface={surface} />;
}

export const DesktopAgentGUIWorkbenchBody = memo(
  DesktopAgentGUIWorkbenchBodyAdapter,
  areDesktopAgentGUIWorkbenchBodyPropsEqual
);
