import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { AgentGUI } from "@tutti-os/agent-gui/agent-gui";
import type { AgentGUIProps, AgentHostInputApi } from "@tutti-os/agent-gui";
import {
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  type AgentGuiWorkbenchNewConversationDetail
} from "@tutti-os/agent-gui/workbench/contribution";
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
  resolveDesktopAgentGUIProviderForAgentTarget,
  withDesktopAgentGUIProviderComposerDefaults
} from "./desktopAgentGUIWorkbenchStateHelpers.ts";
import { useDesktopAgentProbes } from "./useDesktopAgentProbes.ts";
import {
  AGENT_PROBE_REFRESH_DEBOUNCE_MS,
  DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
  DESKTOP_AGENT_GUI_AGENT_SETTINGS,
  DESKTOP_AGENT_GUI_NOOP,
  DESKTOP_AGENT_GUI_POSITION,
  areDesktopAgentGUIWorkbenchBodyPropsEqual,
  handleDesktopAgentGUIShowMessage,
  resolveComputerUseAuthorizationState,
  type DesktopAgentGUIConversationRailToggleDetail,
  type DesktopAgentGUIWorkbenchBodyProps
} from "./desktopAgentGUIWorkbenchModel.ts";
export { DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT } from "./desktopAgentGUIWorkbenchModel.ts";
export type { DesktopAgentGUIConversationRailToggleDetail } from "./desktopAgentGUIWorkbenchModel.ts";
import { useDesktopAgentGUIContextMentions } from "./useDesktopAgentGUIContextMentions.ts";
import { useDesktopAgentGUIReadiness } from "./useDesktopAgentGUIReadiness.ts";
import { preloadDesktopAgentGuiMentionBrowse } from "../services/preloadDesktopAgentGuiMentionBrowse.ts";

function DesktopAgentGUIWorkbenchBodyImpl({
  agentActivityRuntime,
  agentHostApi,
  appCenterService,
  agentProviderStatusService,
  context,
  computerUseApi,
  dockPreviewCache,
  onLinkAction,
  onCapabilitySettingsRequest,
  onOpenAgentConversationWindow,
  onStateChange,
  previewMode = false,
  providerStatusBootstrapSnapshot = null,
  agents,
  agentsLoading = false,
  allAgentsPresentation = null,
  renderAgentsEmpty,
  comingSoonAgentProviders,
  defaultAgentTargetId = null,
  contextMentionProviders,
  runtimeApi,
  trackAgentProviderChatReady,
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
}: DesktopAgentGUIWorkbenchBodyProps): JSX.Element {
  const { i18n, locale } = useTranslation();
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const {
    computerUseStatus,
    effectiveManagedAgentsState,
    handleAgentProviderLogin,
    provider,
    providerReadinessGates,
    providerStatusSnapshot
  } = useDesktopAgentGUIReadiness({
    agentActivityRuntime,
    agentProviderStatusService,
    computerUseApi,
    host: context.host,
    instanceId: context.instanceId,
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
      host: context.host,
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
  const rawWorkbenchStateSource = useMemo(
    () => context.externalNodeState ?? context.node.data.runtimeNodeState,
    [context.externalNodeState, context.node.data.runtimeNodeState]
  );
  const rawWorkbenchState = useMemo(
    () => normalizeDesktopAgentGUIWorkbenchState(rawWorkbenchStateSource),
    [rawWorkbenchStateSource]
  );
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
        provider
      ),
    [agents, provider, workbenchAgentTargetId]
  );
  // Remembered defaults are keyed by agent target id; the daemon overlays
  // legacy provider-keyed entries onto local target ids at read time.
  const providerComposerDefaults = workbenchAgentTargetId
    ? (desktopPreferencesState.agentComposerDefaultsByAgentTarget[
        workbenchAgentTargetId
      ] ?? null)
    : null;
  const hasExplicitConversationRailCollapsedState =
    hasDesktopAgentGUIConversationRailCollapsedState(rawWorkbenchStateSource);
  const preferredConversationRailCollapsed =
    isDesktopAgentProvider(nodeProvider) &&
    desktopPreferencesState.agentGuiConversationRailCollapsedByProvider[
      nodeProvider
    ] === true;
  // Derive node state from the workbench store plus provider-default overlay;
  // there is no local mirror or two-way binding.
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
    const nextState = withDesktopAgentGUIProviderComposerDefaults(
      railState,
      nodeProvider,
      providerComposerDefaults
    );
    return nextState;
  }, [
    hasExplicitConversationRailCollapsedState,
    preferredConversationRailCollapsed,
    workbenchState,
    nodeProvider,
    providerComposerDefaults
  ]);
  const nodeStateRef = useRef(nodeState);
  nodeStateRef.current = nodeState;
  // Lets the waiting-decision toast know this session's conversation is
  // already visible, so it can skip a redundant in-app interruption.
  useEffect(() => {
    const agentSessionId = workbenchState.lastActiveAgentSessionId?.trim();
    if (previewMode || !agentSessionId || context.node.isMinimized) {
      return undefined;
    }
    return registerWorkspaceAgentGuiOpenSession(workspaceId, agentSessionId);
  }, [
    context.node.isMinimized,
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
    useState<DesktopAgentGUIPrefillPromptRequest | null>(null);
  const [newConversationRequestSequence, setNewConversationRequestSequence] =
    useState(0);
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
    consumeDesktopAgentGUIOpenSessionActivation({
      activation: context.activation,
      agentActivityRuntime,
      clearNodeActivation: context.host.clearNodeActivation?.bind(context.host),
      handledSequence: handledOpenSessionActivationSequenceRef.current,
      markHandled: (sequence) => {
        handledOpenSessionActivationSequenceRef.current = sequence;
      },
      nodeId: context.node.id,
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
    context.activation,
    context.host,
    context.node.id,
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
      activation: context.activation,
      clearNodeActivation: context.host.clearNodeActivation?.bind(context.host),
      handledSequence: handledPrefillPromptActivationSequenceRef.current,
      markHandled: (sequence) => {
        handledPrefillPromptActivationSequenceRef.current = sequence;
      },
      nodeId: context.node.id
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
    context.activation,
    context.host,
    context.node.id,
    handleUpdateNode,
    previewMode
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    const handleOptimisticConversationRailToggle = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        !detail ||
        typeof detail !== "object" ||
        !("instanceId" in detail) ||
        !("conversationRailCollapsed" in detail)
      ) {
        return;
      }

      const toggle = detail as DesktopAgentGUIConversationRailToggleDetail;
      if (
        toggle.instanceId !== context.instanceId ||
        typeof toggle.conversationRailCollapsed !== "boolean"
      ) {
        return;
      }

      handleUpdateNode((current) => ({
        ...current,
        conversationRailCollapsed: toggle.conversationRailCollapsed
      }));
    };

    window.addEventListener(
      DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
      handleOptimisticConversationRailToggle
    );
    return () => {
      window.removeEventListener(
        DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT,
        handleOptimisticConversationRailToggle
      );
    };
  }, [context.instanceId, handleUpdateNode, previewMode]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    const handleNewConversationRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object" || !("instanceId" in detail)) {
        return;
      }

      const request = detail as AgentGuiWorkbenchNewConversationDetail;
      if (request.instanceId !== context.instanceId) {
        return;
      }

      setNewConversationRequestSequence((current) => current + 1);
    };

    window.addEventListener(
      AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
      handleNewConversationRequest
    );
    return () => {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
        handleNewConversationRequest
      );
    };
  }, [context.instanceId, previewMode]);

  const openConversationWindowRef = useRef({
    onOpenAgentConversationWindow,
    previewMode,
    provider,
    workspaceId
  });
  useLayoutEffect(() => {
    openConversationWindowRef.current = {
      onOpenAgentConversationWindow,
      previewMode,
      provider,
      workspaceId
    };
  }, [onOpenAgentConversationWindow, previewMode, provider, workspaceId]);
  const canOpenConversationWindow =
    !previewMode && Boolean(onOpenAgentConversationWindow);
  const handleOpenConversationWindow = useMemo(() => {
    if (!canOpenConversationWindow) {
      return undefined;
    }
    return (agentSessionId: string) => {
      const current = openConversationWindowRef.current;
      if (current.previewMode || !current.onOpenAgentConversationWindow) {
        return;
      }
      const trimmedAgentSessionId = agentSessionId.trim();
      if (!trimmedAgentSessionId) {
        return;
      }
      void current.onOpenAgentConversationWindow({
        agentSessionId: trimmedAgentSessionId,
        provider: current.provider,
        workspaceId: current.workspaceId
      });
    };
  }, [canOpenConversationWindow]);

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
      void desktopPreferencesService
        .rememberAgentComposerDefaultsForAgentTarget(agentTargetId, defaults)
        .then(() => {
          logAgentComposerDefaultsDiagnostic({
            defaults,
            event: "agent.gui.composer_defaults.remembered",
            provider: defaultsProvider,
            runtimeApi,
            workspaceId
          });
        })
        .catch((error) => {
          logAgentComposerDefaultsDiagnostic({
            defaults,
            error,
            event: "agent.gui.composer_defaults.remember_failed",
            provider: defaultsProvider,
            runtimeApi,
            workspaceId
          });
        });
    },
    [desktopPreferencesService, previewMode, runtimeApi, workspaceId]
  );

  const frame = context.node.frame;
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
    context.activation?.type === workbenchFocusInputActivationType ||
    context.activation?.type === desktopAgentGUIPrefillPromptActivationType
      ? context.activation.sequence
      : (prefillPromptRequest?.sequence ?? null);
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

  return (
    <>
      <AgentGUI
        agents={agents}
        agentsLoading={agentsLoading}
        allAgentsPresentation={allAgentsPresentation}
        renderAgentsEmpty={renderAgentsEmpty}
        agentActivityRuntime={agentActivityRuntime}
        agentHostApi={agentHostApiWithToast}
        i18n={i18n}
        locale={locale}
        identity={{
          nodeId: context.node.id,
          workspaceId,
          currentUserId: "local",
          title: context.node.title
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
          isMaximized: context.displayMode === "fullscreen",
          isActive: context.isFocused,
          embedded: true,
          previewMode
        }}
        state={nodeState}
        runtimeRequests={{
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
          capabilityMenuState,
          accountMenuState: null,
          comingSoonProviders: comingSoonAgentProviders,
          providerReadinessGates,
          defaultAgentTargetId,
          providerAuthAccountLabels,
          managedAgentsState: effectiveManagedAgentsState,
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
            : async (request) => {
                await requestWorkspaceAgentGuiLaunch({
                  agentTargetId: request.agentTargetId,
                  draftPrompt: request.draftPrompt,
                  openInNewWindow: true,
                  provider: normalizeDesktopAgentGUIProvider(request.provider),
                  userProjectPath: request.userProjectPath,
                  workspaceId
                });
              },
          onResize: DESKTOP_AGENT_GUI_NOOP,
          onShowMessage: handleDesktopAgentGUIShowMessage,
          onUpdateNode: handleUpdateNode,
          onRememberComposerDefaults: handleRememberComposerDefaults,
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

export const DesktopAgentGUIWorkbenchBody = memo(
  DesktopAgentGUIWorkbenchBodyImpl,
  areDesktopAgentGUIWorkbenchBodyPropsEqual
);
