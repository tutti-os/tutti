import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { AgentGUI } from "@tutti-os/agent-gui/agent-gui";
import type { AgentGUIProps, AgentHostInputApi } from "@tutti-os/agent-gui";
import { requestWorkspaceAgentGuiLaunch } from "../services/workspaceAgentGuiLaunchCoordinator.ts";
import { registerWorkspaceAgentGuiOpenSession } from "../../workspace-workbench/services/workspaceAgentGuiOpenSessionCoordinator.ts";
import { workbenchFocusInputActivationType } from "@tutti-os/workbench-surface";
import { useTranslation } from "@renderer/i18n";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
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
import {
  consumeDesktopAgentGUIPrefillPromptActivation,
  type DesktopAgentGUIPrefillPromptRequest
} from "../services/desktopAgentGUIPrefillPromptActivation.ts";
import {
  logAgentComposerDefaultsDiagnostic,
  logAgentGUIConversationRailPreferenceDiagnostic,
  stringifyDiagnosticError
} from "./desktopAgentGUIWorkbenchDiagnostics.ts";
import {
  hasDesktopAgentGUIConversationRailCollapsedState,
  resolveDesktopAgentGUIProviderForAgentTarget
} from "./desktopAgentGUIWorkbenchStateHelpers.ts";
import { useDesktopAgentProbes } from "./useDesktopAgentProbes.ts";
import {
  AGENT_PROBE_REFRESH_DEBOUNCE_MS,
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
export { DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT } from "./desktopAgentGUIWorkbenchModel.ts";
export type { DesktopAgentGUIConversationRailToggleDetail } from "./desktopAgentGUIWorkbenchModel.ts";
import { useDesktopAgentGUIContextMentions } from "./useDesktopAgentGUIContextMentions.ts";
import { useDesktopAgentGUIReadiness } from "./useDesktopAgentGUIReadiness.ts";
import { useDesktopAgentGUIOpenConversationWindow } from "./useDesktopAgentGUIOpenConversationWindow.ts";
import { useDesktopAgentGUIWorkbenchEvents } from "./useDesktopAgentGUIWorkbenchEvents.ts";
import { preloadDesktopAgentGuiMentionBrowse } from "../services/preloadDesktopAgentGuiMentionBrowse.ts";
import { DESKTOP_AGENT_GUI_CURRENT_USER_ID } from "../services/desktopAgentGuiIdentity.ts";
import {
  AGENT_REFERENCE_PROVENANCE_FILTER_FLAG,
  isFeatureEnabled
} from "../../../../../shared/featureFlags/catalog.ts";

function DesktopAgentGUISurfaceImpl({
  agentActivityRuntime,
  agentHostApi,
  appCenterService,
  agentProviderStatusService,
  surface,
  computerUseApi,
  composerAppendRequest = null,
  conversationRailAutoCollapseWidthPx = null,
  dockPreviewCache,
  onLinkAction,
  onCapabilitySettingsRequest,
  onOpenAgentConversationWindow,
  onStateChange,
  prefillPromptBootstrapRequest = null,
  previewMode = false,
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
  trackWorkspaceFileReferences,
  workspaceFileReferenceAdapter,
  resolveDroppedFileReferences,
  onRequestGitBranches,
  referenceSourceAggregator,
  renderSidebarFooter,
  resolveWorkspaceReferenceEntryIconUrl,
  resolveMentionReferenceTarget,
  resolveWorkspaceReferenceInitialTarget,
  workspaceId
}: DesktopAgentGUISurfaceProps): JSX.Element {
  const agents = agentDirectory.agents;
  const { i18n, locale } = useTranslation();
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const rawWorkbenchState = normalizeDesktopAgentGUIWorkbenchState(
    surface.state
  );
  const requestedAgentTargetId =
    rawWorkbenchState.agentTargetId?.trim() || defaultAgentTargetId;
  const readinessProvider =
    agents.find((agent) => agent.agentTargetId === requestedAgentTargetId)
      ?.provider ?? null;
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
    previewMode,
    providerStatusBootstrapSnapshot,
    trackAgentProviderChatReady,
    workspaceId
  });
  const { effectiveContextMentionProviders, workspaceAppIcons } =
    useDesktopAgentGUIContextMentions({
      agentActivityRuntime,
      appCenterService,
      contextMentionProviders,
      dockPreviewCache,
      host: surface.host,
      previewMode,
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
    if (previewMode || !agentSessionId || surface.isMinimized) {
      return undefined;
    }
    return registerWorkspaceAgentGuiOpenSession(workspaceId, agentSessionId);
  }, [
    surface.isMinimized,
    previewMode,
    workbenchState.lastActiveAgentSessionId,
    workspaceId
  ]);
  const [agentProbeDemandBySource, setAgentProbeDemandBySource] = useState<
    Record<string, string>
  >({});
  const agentProbeRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [agentProbeRefreshSequence, setAgentProbeRefreshSequence] = useState(0);
  const [openSessionRequest, setOpenSessionRequest] = useState<NonNullable<
    AgentGUIProps["runtimeRequests"]["openSession"]
  > | null>(null);
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
      if (
        !previewMode &&
        previousRailCollapsed !== nextRailCollapsed &&
        isDesktopAgentProvider(next.provider)
      ) {
        void desktopPreferencesService
          .rememberAgentGuiConversationRailCollapsed(
            next.provider,
            nextRailCollapsed
          )
          .then(() => {
            logAgentGUIConversationRailPreferenceDiagnostic({
              collapsed: nextRailCollapsed,
              provider: next.provider,
              runtimeApi,
              workspaceId
            });
          })
          .catch((error) => {
            logAgentGUIConversationRailPreferenceDiagnostic({
              collapsed: nextRailCollapsed,
              error,
              provider: next.provider,
              runtimeApi,
              workspaceId
            });
          });
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
    [
      desktopPreferencesService,
      nodeProvider,
      previewMode,
      runtimeApi,
      workspaceId
    ]
  );
  const agentProbeProviders = useMemo(
    () => Array.from(new Set(Object.values(agentProbeDemandBySource))).sort(),
    [agentProbeDemandBySource]
  );
  const workspaceAgentProbes = useDesktopAgentProbes({
    previewMode,
    providers: agentProbeProviders,
    refreshSequence: agentProbeRefreshSequence,
    runtimeApi,
    workspaceAgentProbes: agentHostApi.workspaceAgentProbes,
    workspaceId
  });
  const handleAgentProbeDemandChange: NonNullable<
    AgentGUIProps["runtimeRequests"]["onProbeDemandChange"]
  > = useCallback((probeProvider, sourceId = "default") => {
    setAgentProbeDemandBySource((current) => {
      if (!probeProvider) {
        if (!(sourceId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[sourceId];
        return next;
      }
      if (current[sourceId] === probeProvider) {
        return current;
      }
      return {
        ...current,
        [sourceId]: probeProvider
      };
    });
  }, []);
  const handleAgentProbeRefreshRequest: NonNullable<
    AgentGUIProps["runtimeRequests"]["onProbeRefreshRequest"]
  > = useCallback((probeProvider, sourceId = "default") => {
    setAgentProbeDemandBySource((current) =>
      current[sourceId] === probeProvider
        ? current
        : { ...current, [sourceId]: probeProvider }
    );
    if (agentProbeRefreshTimerRef.current) {
      clearTimeout(agentProbeRefreshTimerRef.current);
    }
    agentProbeRefreshTimerRef.current = setTimeout(() => {
      agentProbeRefreshTimerRef.current = null;
      setAgentProbeRefreshSequence((current) => current + 1);
    }, AGENT_PROBE_REFRESH_DEBOUNCE_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (agentProbeRefreshTimerRef.current) {
        clearTimeout(agentProbeRefreshTimerRef.current);
        agentProbeRefreshTimerRef.current = null;
      }
    };
  }, []);
  const handleOpenSessionActivationError = useCallback(
    (input: { agentSessionId: string; error: unknown }) => {
      Toast.Error(
        i18n.t("workspace.agentGui.openSessionUnavailableTitle"),
        i18n.t("workspace.agentGui.openSessionUnavailableDescription")
      );
      void runtimeApi?.logTerminalDiagnostic({
        details: {
          agentSessionId: input.agentSessionId,
          error: stringifyDiagnosticError(input.error)
        },
        event: "agent.gui.open_session_activation_failed",
        level: "warn",
        workspaceId
      });
    },
    [i18n, runtimeApi, workspaceId]
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
      onActivationError: handleOpenSessionActivationError,
      onOpenSessionRequest: setOpenSessionRequest,
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
    handleOpenSessionActivationError,
    handleUpdateNode,
    provider,
    agents,
    workspaceId
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
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
  }, [
    surface.activation,
    surface.host,
    surface.nodeId,
    handleUpdateNode,
    previewMode
  ]);

  const newConversationRequestSequence = useDesktopAgentGUIWorkbenchEvents({
    instanceId: surface.instanceId,
    onConversationRailToggle: (conversationRailCollapsed) => {
      handleUpdateNode((current) => ({
        ...current,
        conversationRailCollapsed
      }));
    },
    previewMode
  });

  const handleOpenConversationWindow = useDesktopAgentGUIOpenConversationWindow(
    {
      agentTargetId: workbenchAgentTargetId,
      onOpenAgentConversationWindow,
      previewMode,
      provider: nodeProvider,
      workspaceId
    }
  );

  useEffect(() => {
    if (
      previewMode ||
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
    previewMode,
    workbenchState
  ]);

  const handleRememberComposerDefaults = useCallback<
    NonNullable<AgentGUIProps["hostActions"]["onRememberComposerDefaults"]>
  >(
    ({ agentTargetId, provider: defaultsProvider, defaults }) => {
      // Remembered defaults are keyed strictly by agent target; targets
      // without an agentTargetId (legacy refs) are not persisted.
      if (previewMode || !agentTargetId || !defaults) {
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
    [desktopPreferencesService, previewMode, runtimeApi, workspaceId]
  );

  const frame = surface.frame;
  const agentHostApiWithToast = useMemo<AgentHostInputApi>(
    () => ({
      ...agentHostApi,
      toast: {
        error: Toast.Error,
        info: Toast.tips,
        success: Toast.Success
      }
    }),
    [agentHostApi]
  );
  const desktopSize = useMemo(
    () => ({
      height: Math.max(frame.height, frame.y + frame.height),
      width: Math.max(frame.width, frame.x + frame.width)
    }),
    [frame.height, frame.width, frame.x, frame.y]
  );
  const composerFocusRequestSequence =
    composerAppendRequest?.sequence ??
    (surface.activation?.type === workbenchFocusInputActivationType ||
    surface.activation?.type === desktopAgentGUIPrefillPromptActivationType
      ? surface.activation.sequence
      : (prefillPromptRequest?.sequence ?? null));
  const capabilityMenuState = useMemo<
    AgentGUIProps["hostCapabilities"]["capabilityMenuState"]
  >(
    () => ({
      browserUse: {
        connectionMode: desktopPreferencesState.browserUseConnectionMode
      },
      computerUse: {
        authorization: resolveComputerUseAuthorizationState(computerUseStatus),
        installed: computerUseStatus?.installed ?? null
      }
    }),
    [computerUseStatus, desktopPreferencesState.browserUseConnectionMode]
  );
  const referenceProvenanceFilterEnabled =
    !previewMode &&
    isFeatureEnabled(
      desktopPreferencesState.featureFlags,
      AGENT_REFERENCE_PROVENANCE_FILTER_FLAG
    );
  const providerAuthAccountLabels = useMemo(() => {
    const labels: Partial<Record<WorkspaceAgentProvider, string>> = {};
    for (const status of providerStatusSnapshot.statuses) {
      const accountLabel = status.auth.accountLabel?.trim();
      if (accountLabel) {
        labels[status.provider] = accountLabel;
      }
    }
    return labels;
  }, [providerStatusSnapshot.statuses]);
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

  return (
    <>
      <AgentGUI
        agentDirectory={agentDirectory}
        allAgentsPresentation={allAgentsPresentation}
        renderAgentsEmpty={renderAgentsEmpty}
        agentActivityRuntime={agentActivityRuntime}
        agentHostApi={agentHostApiWithToast}
        i18n={i18n}
        locale={locale}
        identity={{
          nodeId: surface.nodeId,
          workspaceId,
          currentUserId: DESKTOP_AGENT_GUI_CURRENT_USER_ID,
          title: surface.nodeTitle
        }}
        workspace={{
          path: "",
          fileReferenceAdapter: previewMode
            ? null
            : workspaceFileReferenceAdapter,
          onRequestGitBranches: previewMode ? null : onRequestGitBranches,
          resolveDroppedFileReferences: previewMode
            ? null
            : resolveDroppedFileReferences,
          referenceSourceAggregator: previewMode
            ? null
            : referenceSourceAggregator,
          resolveReferenceEntryIconUrl: previewMode
            ? undefined
            : resolveWorkspaceReferenceEntryIconUrl,
          resolveMentionReferenceTarget: previewMode
            ? undefined
            : resolveMentionReferenceTarget,
          resolveReferenceInitialTarget: previewMode
            ? undefined
            : resolveWorkspaceReferenceInitialTarget,
          onFileReferencesAdded: previewMode
            ? undefined
            : trackWorkspaceFileReferences,
          agentSettings: DESKTOP_AGENT_GUI_AGENT_SETTINGS
        }}
        frame={{
          position: DESKTOP_AGENT_GUI_POSITION,
          width: frame.width,
          height: frame.height,
          desktopSize,
          isMaximized: surface.displayMode === "fullscreen",
          isActive: surface.isFocused,
          isVisible:
            surface.presentationMode !== "mission-control" &&
            surface.isMinimized !== true,
          embedded: true,
          previewMode,
          conversationRailAutoCollapseWidthPx
        }}
        state={nodeState}
        runtimeRequests={{
          composerAppend: composerAppendRequest,
          composerFocusSequence: composerFocusRequestSequence,
          newConversationSequence: newConversationRequestSequence,
          openSession: openSessionRequest,
          prefillPrompt: prefillPromptRequest,
          agentProbes: workspaceAgentProbes,
          onProbeDemandChange: previewMode
            ? undefined
            : handleAgentProbeDemandChange,
          onProbeRefreshRequest: previewMode
            ? undefined
            : handleAgentProbeRefreshRequest
        }}
        hostCapabilities={{
          referenceProvenanceFilterEnabled,
          capabilityMenuState,
          accountMenuState: null,
          comingSoonProviders: comingSoonAgentProviders,
          providerReadinessGates,
          defaultAgentTargetId,
          providerAuthAccountLabels,
          contextMentionProviders: previewMode
            ? []
            : effectiveContextMentionProviders,
          workspaceAppIcons
        }}
        hostActions={{
          onAgentProviderLogin:
            !previewMode && agentProviderStatusService
              ? handleAgentProviderLogin
              : undefined,
          onCapabilitySettingsRequest: previewMode
            ? undefined
            : onCapabilitySettingsRequest,
          onClose: DESKTOP_AGENT_GUI_NOOP,
          onLinkAction: previewMode ? undefined : onLinkAction,
          onHandoffConversation: previewMode
            ? undefined
            : handleHandoffConversation,
          onResize: DESKTOP_AGENT_GUI_NOOP,
          onShowMessage: handleDesktopAgentGUIShowMessage,
          onUpdateNode: handleUpdateNode,
          onRememberComposerDefaults: handleRememberComposerDefaults,
          onEngagementEvent: previewMode ? undefined : onEngagementEvent,
          onOpenConversationWindow:
            previewMode || !onOpenAgentConversationWindow
              ? undefined
              : handleOpenConversationWindow
        }}
        renderSlots={{
          sidebarFooter: previewMode ? undefined : renderSidebarFooter
        }}
      />
    </>
  );
}

export const DesktopAgentGUISurface = DesktopAgentGUISurfaceImpl;

function DesktopAgentGUIWorkbenchBodyAdapter({
  context,
  ...props
}: DesktopAgentGUIWorkbenchBodyProps): JSX.Element {
  const surface: DesktopAgentGUISurfaceContext = {
    activation: context.activation,
    displayMode: context.displayMode,
    frame: context.node.frame,
    host: context.host,
    instanceId: context.instanceId,
    isDragging: context.isDragging,
    isFocused: context.isFocused,
    isMinimized: context.node.isMinimized === true,
    isResizing: context.isResizing,
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
