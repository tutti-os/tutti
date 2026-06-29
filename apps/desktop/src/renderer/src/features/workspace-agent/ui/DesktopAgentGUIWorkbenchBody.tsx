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
import { useSnapshot } from "valtio";
import { AgentGUI } from "@tutti-os/agent-gui";
import type {
  AgentActivityRuntime,
  AgentGUIProps,
  AgentHostInputApi
} from "@tutti-os/agent-gui";
import {
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT,
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  type AgentGuiWorkbenchConversationRailToggleDetail,
  type AgentGuiWorkbenchNewConversationDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { WorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import {
  workbenchFocusInputActivationType,
  type WorkbenchDockPreviewCache,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import { useTranslation } from "@renderer/i18n";
import type { IAgentProviderStatusService } from "../services/agentProviderStatusService.interface";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import { Toast } from "@renderer/lib/toast";
import type { DesktopComputerUseApi, DesktopRuntimeApi } from "@preload/types";
import type { DesktopComputerUseStatus } from "@shared/contracts/ipc";
import {
  areDesktopAgentGUINodeStatesEqual,
  areDesktopAgentGUIWorkbenchStatesEqual,
  desktopAgentGUIProviderFromInstanceId,
  desktopAgentGUIPrefillPromptActivationType,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState,
  type DesktopAgentGUIWorkbenchState
} from "../desktopAgentGUINodeState";
import { consumeDesktopAgentGUIOpenSessionActivation } from "../services/desktopAgentGUIOpenSessionActivation.ts";
import {
  consumeDesktopAgentGUIPrefillPromptActivation,
  type DesktopAgentGUIPrefillPromptRequest
} from "../services/desktopAgentGUIPrefillPromptActivation.ts";
import { isDesktopManagedAgentProvider } from "../services/internal/desktopManagedAgentProviders.ts";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/context-mention-provider";
import { resolveWorkbenchDockFileMentionItems } from "../services/internal/resolveWorkbenchDockFileMentionItems.ts";
import { createDesktopAgentGeneratedFileMentionProvider } from "../services/internal/createDesktopAgentGeneratedFileMentionProvider.ts";
import { composeDesktopAgentGuiContextMentionProviders } from "../services/internal/composeDesktopAgentGuiContextMentionProviders.ts";
import { resolveDesktopWorkspaceAppIconEntries } from "../services/internal/desktopWorkspaceAppIcons.ts";
import { wrapDesktopFileMentionProviderWithDockFiles } from "../services/internal/wrapDesktopFileMentionProviderWithDockFiles.ts";
import {
  desktopAgentComposerDefaultsEqual,
  desktopAgentComposerOverridesToDefaults,
  resolveDesktopAgentComposerDefaultsWriteIntent,
  shouldRememberDesktopAgentComposerDefaults,
  type DesktopAgentComposerDefaultsWriteIntent
} from "../services/internal/desktopAgentComposerDefaultsWriteGate.ts";
import {
  logAgentComposerDefaultsDiagnostic,
  logAgentGUIConversationRailPreferenceDiagnostic,
  stringifyDiagnosticError
} from "./desktopAgentGUIWorkbenchDiagnostics.ts";
import {
  hasDesktopAgentGUIConversationRailCollapsedState,
  withDesktopAgentGUIProviderComposerDefaults
} from "./desktopAgentGUIWorkbenchStateHelpers.ts";
import { useDesktopManagedAgentsState } from "./useDesktopManagedAgentsState.ts";

export const DESKTOP_AGENT_GUI_CONVERSATION_RAIL_TOGGLE_EVENT =
  AGENT_GUI_WORKBENCH_CONVERSATION_RAIL_TOGGLE_EVENT;

export type DesktopAgentGUIConversationRailToggleDetail =
  AgentGuiWorkbenchConversationRailToggleDetail;

interface DesktopAgentGUIWorkbenchBodyProps {
  agentActivityRuntime: AgentActivityRuntime;
  agentHostApi: AgentHostInputApi;
  appCenterService: IWorkspaceAppCenterService;
  agentProviderStatusService?: IAgentProviderStatusService;
  context: WorkbenchHostNodeBodyContext;
  computerUseApi?: Pick<DesktopComputerUseApi, "checkStatus">;
  dockPreviewCache: WorkbenchDockPreviewCache;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onCapabilitySettingsRequest?: AgentGUIProps["onCapabilitySettingsRequest"];
  onOpenAgentConversationWindow?: (input: {
    agentSessionId: string;
    provider: DesktopAgentGUINodeState["provider"];
    workspaceId: string;
  }) => Promise<void> | void;
  onOpenTerminalAtCwd?: AgentGUIProps["onOpenTerminalAtCwd"];
  onStateChange: (state: DesktopAgentGUIWorkbenchState) => void;
  terminalFallbackCwd?: string | null;
  previewMode?: boolean;
  contextMentionProviders: NonNullable<
    AgentGUIProps["contextMentionProviders"]
  >;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  trackAgentProviderChatReady?: (input: { provider: string }) => Promise<void>;
  trackWorkspaceFileReferences?: AgentGUIProps["onWorkspaceFileReferencesAdded"];
  workspaceFileReferenceAdapter: NonNullable<
    AgentGUIProps["workspaceFileReferenceAdapter"]
  >;
  onRequestGitBranches: NonNullable<AgentGUIProps["onRequestGitBranches"]>;
  referenceSourceAggregator?: AgentGUIProps["referenceSourceAggregator"];
  resolveMentionReferenceTarget?: AgentGUIProps["resolveMentionReferenceTarget"];
  resolveWorkspaceReferenceInitialTarget?: AgentGUIProps["resolveWorkspaceReferenceInitialTarget"];
  workspaceId: string;
}

function resolveComputerUseAuthorizationState(
  status: DesktopComputerUseStatus | null
): "authorized" | "needs-authorization" | "unknown" | null {
  if (!status?.installed) {
    return null;
  }
  const permissions = status.permissions;
  if (!permissions || permissions.source !== "driver-daemon") {
    return "unknown";
  }
  return permissions.accessibility === true &&
    permissions.screenRecording === true &&
    permissions.screenRecordingCapturable === true
    ? "authorized"
    : "needs-authorization";
}
const DESKTOP_AGENT_GUI_AGENT_SETTINGS = {
  avoidGroupingEdits: false
} satisfies NonNullable<AgentGUIProps["agentSettings"]>;
const DESKTOP_AGENT_GUI_NOOP = (): void => {};
const DESKTOP_AGENT_GUI_EMPTY_CONTEXT_MENTION_PROVIDERS =
  [] satisfies NonNullable<AgentGUIProps["contextMentionProviders"]>;
const DESKTOP_AGENT_GUI_POSITION = { x: 0, y: 0 };
type DesktopAgentProbeState = NonNullable<
  AgentGUIProps["workspaceAgentProbes"]
>;

function areDesktopAgentGUIWorkbenchBodyPropsEqual(
  previous: DesktopAgentGUIWorkbenchBodyProps,
  next: DesktopAgentGUIWorkbenchBodyProps
): boolean {
  return (
    previous.agentActivityRuntime === next.agentActivityRuntime &&
    previous.agentHostApi === next.agentHostApi &&
    previous.appCenterService === next.appCenterService &&
    previous.agentProviderStatusService === next.agentProviderStatusService &&
    previous.computerUseApi === next.computerUseApi &&
    previous.dockPreviewCache === next.dockPreviewCache &&
    previous.onLinkAction === next.onLinkAction &&
    previous.onCapabilitySettingsRequest === next.onCapabilitySettingsRequest &&
    previous.onOpenAgentConversationWindow ===
      next.onOpenAgentConversationWindow &&
    previous.onOpenTerminalAtCwd === next.onOpenTerminalAtCwd &&
    previous.previewMode === next.previewMode &&
    previous.terminalFallbackCwd === next.terminalFallbackCwd &&
    previous.contextMentionProviders === next.contextMentionProviders &&
    previous.runtimeApi === next.runtimeApi &&
    previous.trackAgentProviderChatReady === next.trackAgentProviderChatReady &&
    previous.trackWorkspaceFileReferences ===
      next.trackWorkspaceFileReferences &&
    previous.workspaceFileReferenceAdapter ===
      next.workspaceFileReferenceAdapter &&
    previous.onRequestGitBranches === next.onRequestGitBranches &&
    previous.referenceSourceAggregator === next.referenceSourceAggregator &&
    previous.resolveMentionReferenceTarget ===
      next.resolveMentionReferenceTarget &&
    previous.resolveWorkspaceReferenceInitialTarget ===
      next.resolveWorkspaceReferenceInitialTarget &&
    previous.workspaceId === next.workspaceId &&
    areDesktopAgentGUIWorkbenchBodyContextsEqual(previous.context, next.context)
  );
}

function areDesktopAgentGUIWorkbenchBodyContextsEqual(
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
      previous.isFocused === next.isFocused &&
      previous.node.id === next.node.id &&
      previous.node.title === next.node.title &&
      previous.node.frame.width === next.node.frame.width &&
      previous.node.frame.height === next.node.frame.height &&
      previous.node.frame.x === next.node.frame.x &&
      previous.node.frame.y === next.node.frame.y &&
      previous.node.data.runtimeNodeState === next.node.data.runtimeNodeState)
  );
}

function desktopComputerUseStatusesEqual(
  left: DesktopComputerUseStatus | null,
  right: DesktopComputerUseStatus | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.installed === right.installed &&
      left.permissions?.accessibility === right.permissions?.accessibility &&
      left.permissions?.screenRecording ===
        right.permissions?.screenRecording &&
      left.permissions?.screenRecordingCapturable ===
        right.permissions?.screenRecordingCapturable &&
      left.permissions?.source === right.permissions?.source)
  );
}

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
  onOpenTerminalAtCwd,
  onStateChange,
  terminalFallbackCwd = null,
  previewMode = false,
  contextMentionProviders,
  runtimeApi,
  trackAgentProviderChatReady,
  trackWorkspaceFileReferences,
  workspaceFileReferenceAdapter,
  onRequestGitBranches,
  referenceSourceAggregator,
  resolveMentionReferenceTarget,
  resolveWorkspaceReferenceInitialTarget,
  workspaceId
}: DesktopAgentGUIWorkbenchBodyProps): JSX.Element {
  const { i18n, locale } = useTranslation();
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const [computerUseStatus, setComputerUseStatus] =
    useState<DesktopComputerUseStatus | null>(null);
  const appCenterState = useSnapshot(appCenterService.store);
  const workspaceAppIcons = useMemo(
    () =>
      resolveDesktopWorkspaceAppIconEntries({
        apps: appCenterState.apps,
        workspaceId
      }),
    [appCenterState.apps, workspaceId]
  );
  const workspaceAppMentionProvider = useMemo(() => {
    if (previewMode) {
      return null;
    }
    return (
      contextMentionProviders.find(
        (provider) =>
          provider.id === AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceApp
      ) ?? null
    );
  }, [contextMentionProviders, previewMode]);
  const agentGeneratedFileMentionProvider = useMemo(
    () =>
      previewMode
        ? null
        : createDesktopAgentGeneratedFileMentionProvider({
            agentActivityRuntime,
            workspaceId
          }),
    [agentActivityRuntime, previewMode, workspaceId]
  );
  const resolveDockFiles = useCallback(
    () =>
      resolveWorkbenchDockFileMentionItems({
        host: context.host,
        workspaceId
      }),
    [context.host, workspaceId]
  );
  const effectiveContextMentionProviders = useMemo(() => {
    if (previewMode || !agentGeneratedFileMentionProvider) {
      return DESKTOP_AGENT_GUI_EMPTY_CONTEXT_MENTION_PROVIDERS;
    }
    return composeDesktopAgentGuiContextMentionProviders({
      baseProviders: contextMentionProviders,
      agentGeneratedFileMentionProvider,
      workspaceAppMentionProvider,
      wrapBaseProvider: (provider) =>
        wrapDesktopFileMentionProviderWithDockFiles(provider, {
          readDockPreview: dockPreviewCache.read.bind(dockPreviewCache),
          resolveDockFiles
        })
    });
  }, [
    agentGeneratedFileMentionProvider,
    dockPreviewCache,
    previewMode,
    resolveDockFiles,
    contextMentionProviders,
    workspaceAppMentionProvider
  ]);
  const managedAgentsState = useDesktopManagedAgentsState(
    agentProviderStatusService,
    { ensureLoaded: !previewMode }
  );
  const provider = desktopAgentGUIProviderFromInstanceId(context.instanceId);
  // Activation funnel stage ③ "saw a chattable surface": the agent workbench
  // body is mounted (not a dock preview) and the active provider is ready, so
  // the composer is interactive. reportProviderReady (stage ②) can fire while
  // no agent surface is open; this fires only when the user is actually here.
  const isActiveAgentProviderChatReady =
    !previewMode &&
    agentProviderStatusService?.getStatus(provider)?.availability.status ===
      "ready";
  const chatReadyReportedProvidersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      previewMode ||
      !isActiveAgentProviderChatReady ||
      !trackAgentProviderChatReady
    ) {
      return;
    }
    if (chatReadyReportedProvidersRef.current.has(provider)) {
      return;
    }
    chatReadyReportedProvidersRef.current.add(provider);
    void trackAgentProviderChatReady({ provider });
  }, [
    isActiveAgentProviderChatReady,
    previewMode,
    provider,
    trackAgentProviderChatReady
  ]);
  // When a turn fails authentication (a dropped login the daemon now flags), the
  // status is pull-based, so re-probe immediately to flip the dock/wizard to
  // "needs login" without the user having to re-detect manually.
  useEffect(() => {
    if (previewMode || !agentProviderStatusService) {
      return;
    }
    return agentActivityRuntime.subscribeSessionEvents(workspaceId, (event) => {
      if (sessionEventLooksLikeAuthFailure(event)) {
        void agentProviderStatusService.refresh([provider]);
      }
    });
  }, [
    agentActivityRuntime,
    agentProviderStatusService,
    previewMode,
    provider,
    workspaceId
  ]);
  useEffect(() => {
    if (previewMode || !computerUseApi) {
      setComputerUseStatus(null);
      return;
    }

    let canceled = false;
    const refreshComputerUseStatus = () => {
      void computerUseApi
        .checkStatus()
        .then((status) => {
          if (!canceled) {
            setComputerUseStatus((current) =>
              desktopComputerUseStatusesEqual(current, status)
                ? current
                : status
            );
          }
        })
        .catch(() => {
          if (!canceled) {
            setComputerUseStatus((current) =>
              desktopComputerUseStatusesEqual(current, null) ? current : null
            );
          }
        });
    };

    refreshComputerUseStatus();
    const interval = window.setInterval(refreshComputerUseStatus, 15_000);
    return () => {
      canceled = true;
      window.clearInterval(interval);
    };
  }, [computerUseApi, previewMode]);
  const handleAgentProviderLogin = useCallback(
    (
      loginProvider: Parameters<
        NonNullable<AgentGUIProps["onAgentProviderLogin"]>
      >[0]
    ) => {
      if (!isDesktopManagedAgentProvider(loginProvider)) {
        return;
      }
      void agentProviderStatusService?.runAction(loginProvider, "login", {
        workbenchHost: context.host,
        workspaceId
      });
    },
    [agentProviderStatusService, context.host, workspaceId]
  );
  const rawWorkbenchStateSource = useMemo(
    () => context.externalNodeState ?? context.node.data.runtimeNodeState,
    [context.externalNodeState, context.node.data.runtimeNodeState]
  );
  const rawWorkbenchState = useMemo(
    () => normalizeDesktopAgentGUIWorkbenchState(rawWorkbenchStateSource),
    [rawWorkbenchStateSource]
  );
  // The workbench host returns a fresh externalNodeState object on every render
  // (its store hands out a defensive copy). Pin it by reference so downstream
  // memos and effects only react to real content changes.
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
  const providerComposerDefaults =
    desktopPreferencesState.agentComposerDefaultsByProvider[provider] ?? null;
  const hasExplicitConversationRailCollapsedState =
    hasDesktopAgentGUIConversationRailCollapsedState(rawWorkbenchStateSource);
  const preferredConversationRailCollapsed =
    desktopPreferencesState.agentGuiConversationRailCollapsedByProvider[
      provider
    ] === true;
  // Single source of truth: derive the node state directly from the workbench
  // external store (plus a pure provider-default overlay). There is no local
  // mirror, so the previous two-way binding and its render loop are gone.
  const nodeState = useMemo(() => {
    const baseState = normalizeDesktopAgentGUINodeState(
      workbenchState,
      provider
    );
    const railState =
      !hasExplicitConversationRailCollapsedState &&
      preferredConversationRailCollapsed
        ? { ...baseState, conversationRailCollapsed: true }
        : baseState;
    return withDesktopAgentGUIProviderComposerDefaults(
      railState,
      provider,
      providerComposerDefaults
    );
  }, [
    hasExplicitConversationRailCollapsedState,
    preferredConversationRailCollapsed,
    workbenchState,
    provider,
    providerComposerDefaults
  ]);
  const nodeStateRef = useRef(nodeState);
  nodeStateRef.current = nodeState;
  const [agentProbeDemandBySource, setAgentProbeDemandBySource] = useState<
    Record<string, string>
  >({});
  const [workspaceAgentProbes, setWorkspaceAgentProbes] =
    useState<DesktopAgentProbeState | null>(null);
  const [openSessionRequest, setOpenSessionRequest] = useState<NonNullable<
    AgentGUIProps["openSessionRequest"]
  > | null>(null);
  const [prefillPromptRequest, setPrefillPromptRequest] =
    useState<DesktopAgentGUIPrefillPromptRequest | null>(null);
  const [newConversationRequestSequence, setNewConversationRequestSequence] =
    useState(0);
  const handledOpenSessionActivationSequenceRef = useRef<number | null>(null);
  const handledPrefillPromptActivationSequenceRef = useRef<number | null>(null);
  const pendingComposerDefaultsWriteRef =
    useRef<DesktopAgentComposerDefaultsWriteIntent | null>(null);
  // onStateChange is recreated on every host render; pin it so the writer stays
  // referentially stable and effects don't resubscribe each render.
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  // The only writer. Reads the live derived node state, applies the update,
  // and persists to the workbench store via onStateChange when the projected
  // workbench state actually changes.
  const handleUpdateNode = useCallback(
    (
      updater: (current: DesktopAgentGUINodeState) => DesktopAgentGUINodeState
    ) => {
      const current = nodeStateRef.current;
      const next = normalizeDesktopAgentGUINodeState(
        updater(current),
        provider
      );
      if (areDesktopAgentGUINodeStatesEqual(current, next)) {
        return;
      }
      nodeStateRef.current = next;
      const writeIntent = resolveDesktopAgentComposerDefaultsWriteIntent(
        current,
        next
      );
      if (writeIntent !== undefined) {
        pendingComposerDefaultsWriteRef.current = writeIntent;
      }
      const previousRailCollapsed = current.conversationRailCollapsed === true;
      const nextRailCollapsed = next.conversationRailCollapsed === true;
      if (!previewMode && previousRailCollapsed !== nextRailCollapsed) {
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
    [desktopPreferencesService, previewMode, provider, runtimeApi, workspaceId]
  );
  const agentProbeProviders = useMemo(
    () => Array.from(new Set(Object.values(agentProbeDemandBySource))).sort(),
    [agentProbeDemandBySource]
  );
  const agentProbeProvidersKey = agentProbeProviders.join("\u0000");
  const handleAgentProbeDemandChange: NonNullable<
    AgentGUIProps["onAgentProbeDemandChange"]
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
    if (previewMode) {
      return;
    }
    if (agentProbeProviders.length === 0) {
      setWorkspaceAgentProbes(null);
      return;
    }
    const agentProbeApi = agentHostApi.workspaceAgentProbes;
    if (!agentProbeApi) {
      return;
    }
    let canceled = false;
    setWorkspaceAgentProbes((current) => ({
      isLoadingAvailability: current?.snapshot === null,
      isLoadingUsage: true,
      snapshot: current?.snapshot ?? null
    }));
    void agentProbeApi
      .list({
        includeUsage: true,
        providers: agentProbeProviders,
        refresh: true,
        workspaceId
      })
      .then((snapshot) => {
        if (canceled) {
          return;
        }
        setWorkspaceAgentProbes({
          isLoadingAvailability: false,
          isLoadingUsage: false,
          snapshot
        });
      })
      .catch((error) => {
        if (canceled) {
          return;
        }
        setWorkspaceAgentProbes((current) => ({
          isLoadingAvailability: false,
          isLoadingUsage: false,
          snapshot: current?.snapshot ?? null
        }));
        void runtimeApi?.logTerminalDiagnostic({
          details: {
            error: error instanceof Error ? error.message : String(error),
            providers: agentProbeProviders.join(",")
          },
          event: "agent.gui.probe.usage_failed",
          level: "warn",
          workspaceId
        });
      });
    return () => {
      canceled = true;
    };
  }, [
    agentHostApi.workspaceAgentProbes,
    agentProbeProviders,
    agentProbeProvidersKey,
    runtimeApi,
    previewMode,
    workspaceId
  ]);

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
      setPrefillPromptRequest(request);
    }
  }, [context.activation, context.host, context.node.id, previewMode]);

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
      provider
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
    preferredConversationRailCollapsed,
    previewMode,
    provider,
    workbenchState
  ]);

  const activeComposerSettings =
    nodeState.composerOverridesByProvider?.[nodeState.provider] ??
    nodeState.composerOverrides ??
    null;
  useEffect(() => {
    if (previewMode) {
      return;
    }
    if (!activeComposerSettings) {
      return;
    }
    const defaults = desktopAgentComposerOverridesToDefaults(
      activeComposerSettings
    );
    if (!defaults) {
      return;
    }
    const pendingWrite = pendingComposerDefaultsWriteRef.current;
    if (
      !shouldRememberDesktopAgentComposerDefaults({
        defaults,
        pendingWrite,
        provider: nodeState.provider
      })
    ) {
      return;
    }
    pendingComposerDefaultsWriteRef.current = null;
    if (desktopAgentComposerDefaultsEqual(providerComposerDefaults, defaults)) {
      return;
    }
    void desktopPreferencesService
      .rememberAgentComposerDefaults(nodeState.provider, defaults)
      .then(() => {
        logAgentComposerDefaultsDiagnostic({
          defaults,
          event: "agent.gui.composer_defaults.remembered",
          provider: nodeState.provider,
          runtimeApi,
          workspaceId
        });
      })
      .catch((error) => {
        logAgentComposerDefaultsDiagnostic({
          defaults,
          error,
          event: "agent.gui.composer_defaults.remember_failed",
          provider: nodeState.provider,
          runtimeApi,
          workspaceId
        });
      });
  }, [
    activeComposerSettings,
    desktopPreferencesService,
    nodeState.provider,
    providerComposerDefaults,
    runtimeApi,
    previewMode,
    workspaceId
  ]);

  const frame = context.node.frame;
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
  const capabilityMenuState = useMemo<AgentGUIProps["capabilityMenuState"]>(
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

  return (
    <>
      <AgentGUI
        agentActivityRuntime={agentActivityRuntime}
        agentHostApi={agentHostApi}
        i18n={i18n}
        locale={locale}
        agentSettings={DESKTOP_AGENT_GUI_AGENT_SETTINGS}
        capabilityMenuState={capabilityMenuState}
        currentUserId="local"
        desktopSize={desktopSize}
        embedded
        height={frame.height}
        isMaximized={context.displayMode === "fullscreen"}
        isActive={context.isFocused}
        composerFocusRequestSequence={composerFocusRequestSequence}
        newConversationRequestSequence={newConversationRequestSequence}
        openSessionRequest={openSessionRequest}
        prefillPromptRequest={prefillPromptRequest}
        managedAgentsState={managedAgentsState}
        nodeId={context.node.id}
        workspaceAgentProbes={workspaceAgentProbes}
        onAgentProbeDemandChange={
          previewMode ? undefined : handleAgentProbeDemandChange
        }
        onAgentProviderLogin={
          !previewMode && agentProviderStatusService
            ? handleAgentProviderLogin
            : undefined
        }
        onCapabilitySettingsRequest={
          previewMode ? undefined : onCapabilitySettingsRequest
        }
        onClose={DESKTOP_AGENT_GUI_NOOP}
        onLinkAction={previewMode ? undefined : onLinkAction}
        onResize={DESKTOP_AGENT_GUI_NOOP}
        onShowMessage={DESKTOP_AGENT_GUI_NOOP}
        onUpdateNode={handleUpdateNode}
        onOpenConversationWindow={
          previewMode || !onOpenAgentConversationWindow
            ? undefined
            : handleOpenConversationWindow
        }
        onOpenTerminalAtCwd={previewMode ? undefined : onOpenTerminalAtCwd}
        terminalFallbackCwd={terminalFallbackCwd}
        onWorkspaceFileReferencesAdded={
          previewMode ? undefined : trackWorkspaceFileReferences
        }
        position={DESKTOP_AGENT_GUI_POSITION}
        previewMode={previewMode}
        contextMentionProviders={
          previewMode ? [] : effectiveContextMentionProviders
        }
        state={nodeState}
        title={context.node.title}
        width={frame.width}
        workspaceFileReferenceAdapter={
          previewMode ? null : workspaceFileReferenceAdapter
        }
        onRequestGitBranches={previewMode ? null : onRequestGitBranches}
        referenceSourceAggregator={
          previewMode ? null : referenceSourceAggregator
        }
        resolveMentionReferenceTarget={
          previewMode ? undefined : resolveMentionReferenceTarget
        }
        resolveWorkspaceReferenceInitialTarget={
          previewMode ? undefined : resolveWorkspaceReferenceInitialTarget
        }
        workspaceAppIcons={workspaceAppIcons}
        workspaceId={workspaceId}
        workspacePath="/"
      />
    </>
  );
}

export const DesktopAgentGUIWorkbenchBody = memo(
  DesktopAgentGUIWorkbenchBodyImpl,
  areDesktopAgentGUIWorkbenchBodyPropsEqual
);

const AUTH_FAILURE_MARKERS = [
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
function sessionEventLooksLikeAuthFailure(event: unknown): boolean {
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
