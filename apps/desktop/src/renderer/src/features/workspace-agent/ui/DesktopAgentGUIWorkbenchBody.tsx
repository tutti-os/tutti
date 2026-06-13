import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
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
  type AgentGuiWorkbenchConversationRailToggleDetail
} from "@tutti-os/agent-gui/workbench/contribution";
import type { AgentHostManagedAgentsState } from "@shared/contracts/dto";
import type { IWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import type { WorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import {
  workbenchFocusInputActivationType,
  type WorkbenchDockPreviewCache,
  type WorkbenchHostNodeBodyContext
} from "@tutti-os/workbench-surface";
import { useTranslation } from "@renderer/i18n";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../services/agentProviderStatusService.interface";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences/ui/useDesktopPreferencesService";
import type { DesktopAgentComposerDefaults } from "@shared/preferences";
import type { DesktopRuntimeApi } from "@preload/types";
import {
  areDesktopAgentGUINodeStatesEqual,
  areDesktopAgentGUIWorkbenchStatesEqual,
  desktopAgentGUIProviderFromInstanceId,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUIComposerOverrides,
  type DesktopAgentGUINodeState,
  type DesktopAgentGUIWorkbenchState,
  type DesktopAgentGUIProvider
} from "../desktopAgentGUINodeState";
import { consumeDesktopAgentGUIOpenSessionActivation } from "../services/desktopAgentGUIOpenSessionActivation.ts";
import {
  ensureDesktopManagedAgentProviderStatuses,
  isDesktopManagedAgentProvider,
  projectDesktopManagedAgentsState
} from "../services/internal/desktopManagedAgentProviders.ts";
import { createDesktopWorkspaceAppMentionProvider } from "./desktopWorkspaceAppMentionProvider.ts";
import { AGENT_GUI_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/agent-rich-text-at-provider";
import { resolveWorkbenchDockFileAtItems } from "../services/internal/resolveWorkbenchDockFileAtItems.ts";
import { createDesktopAgentGeneratedFileMentionProvider } from "../services/internal/createDesktopAgentGeneratedFileMentionProvider.ts";
import { wrapDesktopFileMentionProviderWithDockFiles } from "../services/internal/wrapDesktopFileMentionProviderWithDockFiles.ts";
import {
  desktopAgentComposerDefaultsEqual,
  desktopAgentComposerOverridesToDefaults,
  normalizedDesktopAgentComposerDefaultValue,
  resolveDesktopAgentComposerDefaultsWriteIntent,
  shouldRememberDesktopAgentComposerDefaults,
  type DesktopAgentComposerDefaultsWriteIntent
} from "../services/internal/desktopAgentComposerDefaultsWriteGate.ts";

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
  dockPreviewCache: WorkbenchDockPreviewCache;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onStateChange: (state: DesktopAgentGUIWorkbenchState) => void;
  previewMode?: boolean;
  richTextAtProviders: NonNullable<AgentGUIProps["richTextAtProviders"]>;
  resolveAppIconUrl?: (appId: string) => string | null;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  trackWorkspaceFileReferences?: AgentGUIProps["onWorkspaceFileReferencesAdded"];
  workspaceFileReferenceAdapter: NonNullable<
    AgentGUIProps["workspaceFileReferenceAdapter"]
  >;
  workspaceId: string;
}

const EMPTY_AGENT_PROVIDER_STATUS_SNAPSHOT: AgentProviderStatusSnapshot = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
};
const DESKTOP_AGENT_GUI_AGENT_SETTINGS = {
  avoidGroupingEdits: false
} satisfies NonNullable<AgentGUIProps["agentSettings"]>;
const DESKTOP_AGENT_GUI_NOOP = (): void => {};
const DESKTOP_AGENT_GUI_POSITION = { x: 0, y: 0 };

type DesktopAgentProbeState = NonNullable<
  AgentGUIProps["workspaceAgentProbes"]
>;

interface DesktopAgentGUIErrorBoundaryProps {
  children: JSX.Element;
  nodeId: string;
  provider: DesktopAgentGUIProvider;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceId: string;
}

interface DesktopAgentGUIErrorBoundaryState {
  hasError: boolean;
}

class DesktopAgentGUIErrorBoundary extends Component<
  DesktopAgentGUIErrorBoundaryProps,
  DesktopAgentGUIErrorBoundaryState
> {
  state: DesktopAgentGUIErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): DesktopAgentGUIErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    void this.props.runtimeApi
      ?.logTerminalDiagnostic({
        details: {
          componentStack: info.componentStack ?? null,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : typeof error,
          errorStack: error instanceof Error ? (error.stack ?? null) : null,
          nodeId: this.props.nodeId,
          provider: this.props.provider
        },
        event: "agent.gui.workbench_body.render_error",
        level: "error",
        workspaceId: this.props.workspaceId
      })
      .catch(() => undefined);
  }

  override render(): JSX.Element {
    if (this.state.hasError) {
      return (
        <div
          className="h-full w-full bg-background"
          data-agent-gui-workbench-render-error="true"
        />
      );
    }
    return this.props.children;
  }
}

function withDesktopAgentGUIProviderComposerDefaults(
  state: DesktopAgentGUINodeState,
  provider: DesktopAgentGUIProvider,
  defaults: DesktopAgentComposerDefaults | null
): DesktopAgentGUINodeState {
  if (
    !defaults ||
    state.lastActiveAgentSessionId ||
    state.composerOverrides ||
    state.composerOverridesByProvider?.[provider]
  ) {
    return state;
  }

  const composerOverrides =
    desktopAgentComposerDefaultsToComposerOverrides(defaults);
  if (!composerOverrides) {
    return state;
  }

  return normalizeDesktopAgentGUINodeState(
    {
      ...state,
      composerOverrides,
      composerOverridesByProvider: {
        ...(state.composerOverridesByProvider ?? {}),
        [provider]: composerOverrides
      }
    },
    provider
  );
}

function desktopAgentComposerDefaultsToComposerOverrides(
  defaults: DesktopAgentComposerDefaults
): DesktopAgentGUIComposerOverrides | null {
  const composerOverrides: DesktopAgentGUIComposerOverrides = {};
  if (defaults.model?.trim()) {
    composerOverrides.model = defaults.model.trim();
  }
  if (defaults.permissionModeId?.trim()) {
    composerOverrides.permissionModeId = defaults.permissionModeId.trim();
  }
  if (defaults.reasoningEffort?.trim()) {
    composerOverrides.reasoningEffort = defaults.reasoningEffort.trim();
  }
  return Object.keys(composerOverrides).length > 0 ? composerOverrides : null;
}

function logAgentComposerDefaultsDiagnostic(input: {
  defaults: DesktopAgentComposerDefaults;
  error?: unknown;
  event:
    | "agent.gui.composer_defaults.remembered"
    | "agent.gui.composer_defaults.remember_failed";
  provider: DesktopAgentGUIProvider;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceId: string;
}): void {
  if (!input.runtimeApi) {
    return;
  }
  void input.runtimeApi.logTerminalDiagnostic({
    details: {
      defaultModel:
        normalizedDesktopAgentComposerDefaultValue(input.defaults.model) ||
        null,
      defaultPermissionModeId:
        normalizedDesktopAgentComposerDefaultValue(
          input.defaults.permissionModeId
        ) || null,
      defaultReasoningEffort:
        normalizedDesktopAgentComposerDefaultValue(
          input.defaults.reasoningEffort
        ) || null,
      ...(input.error ? { error: stringifyDiagnosticError(input.error) } : {}),
      provider: input.provider
    },
    event: input.event,
    level: input.error ? "warn" : "info",
    workspaceId: input.workspaceId
  });
}

function stringifyDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function DesktopAgentGUIWorkbenchBody({
  agentActivityRuntime,
  agentHostApi,
  appCenterService,
  agentProviderStatusService,
  context,
  dockPreviewCache,
  onLinkAction,
  onStateChange,
  previewMode = false,
  richTextAtProviders,
  resolveAppIconUrl,
  runtimeApi,
  trackWorkspaceFileReferences,
  workspaceFileReferenceAdapter,
  workspaceId
}: DesktopAgentGUIWorkbenchBodyProps): JSX.Element {
  const { i18n, locale } = useTranslation();
  const { service: desktopPreferencesService, state: desktopPreferencesState } =
    useDesktopPreferencesService();
  const appCenterState = useSnapshot(appCenterService.store);
  const workspaceAppIcons = useMemo(
    () =>
      appCenterState.apps
        .map((app) => ({
          appId: app.appId,
          iconUrl:
            resolveAppIconUrl?.(app.appId) ??
            app.iconUrl ??
            app.availableIconUrl ??
            null,
          workspaceId
        }))
        .filter((app) => app.iconUrl),
    [appCenterState.apps, resolveAppIconUrl, workspaceId]
  );
  const workspaceAppMentionProvider = useMemo(() => {
    const baseProvider = richTextAtProviders.find(
      (provider) => provider.id === AGENT_GUI_MENTION_PROVIDER_IDS.workspaceApp
    );
    return baseProvider
      ? createDesktopWorkspaceAppMentionProvider({
          apps: appCenterState.apps,
          baseProvider,
          locale,
          resolveAppIconUrl,
          workspaceId
        })
      : null;
  }, [
    appCenterState.apps,
    locale,
    resolveAppIconUrl,
    richTextAtProviders,
    workspaceId
  ]);
  const resolveDockFiles = useCallback(
    () =>
      resolveWorkbenchDockFileAtItems({
        host: context.host,
        workspaceId
      }),
    [context.host, workspaceId]
  );
  const agentGeneratedFileMentionProvider = useMemo(
    () =>
      createDesktopAgentGeneratedFileMentionProvider({
        agentActivityRuntime,
        workspaceId
      }),
    [agentActivityRuntime, workspaceId]
  );
  const effectiveRichTextAtProviders = useMemo(
    () => [
      ...richTextAtProviders
        .filter(
          (provider) =>
            provider.id !== AGENT_GUI_MENTION_PROVIDER_IDS.workspaceApp
        )
        .map((provider) =>
          wrapDesktopFileMentionProviderWithDockFiles(provider, {
            readDockPreview: dockPreviewCache.read.bind(dockPreviewCache),
            resolveDockFiles
          })
        ),
      agentGeneratedFileMentionProvider,
      ...(workspaceAppMentionProvider ? [workspaceAppMentionProvider] : [])
    ],
    [
      agentGeneratedFileMentionProvider,
      dockPreviewCache,
      resolveDockFiles,
      richTextAtProviders,
      workspaceAppMentionProvider
    ]
  );
  const managedAgentsState = useDesktopManagedAgentsState(
    previewMode ? undefined : agentProviderStatusService
  );
  const provider = desktopAgentGUIProviderFromInstanceId(context.instanceId);
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
  const workbenchState = useMemo(
    () =>
      normalizeDesktopAgentGUIWorkbenchState(
        context.externalNodeState ?? context.node.data.runtimeNodeState
      ),
    [context.externalNodeState, context.node.data.runtimeNodeState]
  );
  const providerComposerDefaults =
    desktopPreferencesState.agentComposerDefaultsByProvider[provider] ?? null;
  const normalizedExternalState = useMemo(
    () =>
      withDesktopAgentGUIProviderComposerDefaults(
        normalizeDesktopAgentGUINodeState(workbenchState, provider),
        provider,
        providerComposerDefaults
      ),
    [workbenchState, provider, providerComposerDefaults]
  );
  const [state, setState] = useState<DesktopAgentGUINodeState>(
    normalizedExternalState
  );
  const [agentProbeDemandBySource, setAgentProbeDemandBySource] = useState<
    Record<string, string>
  >({});
  const [workspaceAgentProbes, setWorkspaceAgentProbes] =
    useState<DesktopAgentProbeState | null>(null);
  const lastRequestedWorkbenchStateRef =
    useRef<DesktopAgentGUIWorkbenchState | null>(null);
  const handledOpenSessionActivationSequenceRef = useRef<number | null>(null);
  const pendingComposerDefaultsWriteRef =
    useRef<DesktopAgentComposerDefaultsWriteIntent | null>(null);
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
    setState((current) => {
      const next = normalizeDesktopAgentGUINodeState(
        {
          ...current,
          ...workbenchState,
          provider
        },
        provider
      );
      return areDesktopAgentGUINodeStatesEqual(current, next) ? current : next;
    });
  }, [provider, workbenchState]);

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
      onStateChange,
      provider,
      workspaceId,
      updateNodeState: setState
    });
  }, [
    agentActivityRuntime,
    context.activation,
    context.host,
    context.node.id,
    onStateChange,
    provider,
    workspaceId
  ]);

  useEffect(() => {
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

      setState((current) => {
        const next = normalizeDesktopAgentGUINodeState(
          {
            ...current,
            conversationRailCollapsed: toggle.conversationRailCollapsed
          },
          provider
        );
        return areDesktopAgentGUINodeStatesEqual(current, next)
          ? current
          : next;
      });
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
  }, [context.instanceId, provider]);

  const handleUpdateNode = useCallback(
    (
      updater: (current: DesktopAgentGUINodeState) => DesktopAgentGUINodeState
    ) =>
      setState((current) => {
        const next = normalizeDesktopAgentGUINodeState(
          updater(current),
          provider
        );
        if (areDesktopAgentGUINodeStatesEqual(current, next)) {
          return current;
        }
        const writeIntent = resolveDesktopAgentComposerDefaultsWriteIntent(
          current,
          next
        );
        if (writeIntent !== undefined) {
          pendingComposerDefaultsWriteRef.current = writeIntent;
        }
        return next;
      }),
    [provider]
  );

  useEffect(() => {
    if (previewMode) {
      return;
    }
    const settings =
      state.composerOverridesByProvider?.[state.provider] ??
      state.composerOverrides ??
      null;
    if (!settings) {
      return;
    }
    const defaults = desktopAgentComposerOverridesToDefaults(settings);
    if (!defaults) {
      return;
    }
    const pendingWrite = pendingComposerDefaultsWriteRef.current;
    if (
      !shouldRememberDesktopAgentComposerDefaults({
        defaults,
        pendingWrite,
        provider: state.provider
      })
    ) {
      return;
    }
    pendingComposerDefaultsWriteRef.current = null;
    if (desktopAgentComposerDefaultsEqual(providerComposerDefaults, defaults)) {
      return;
    }
    void desktopPreferencesService
      .rememberAgentComposerDefaults(state.provider, defaults)
      .then(() => {
        logAgentComposerDefaultsDiagnostic({
          defaults,
          event: "agent.gui.composer_defaults.remembered",
          provider: state.provider,
          runtimeApi,
          workspaceId
        });
      })
      .catch((error) => {
        logAgentComposerDefaultsDiagnostic({
          defaults,
          error,
          event: "agent.gui.composer_defaults.remember_failed",
          provider: state.provider,
          runtimeApi,
          workspaceId
        });
      });
  }, [
    desktopPreferencesService,
    providerComposerDefaults,
    runtimeApi,
    state.composerOverrides,
    state.composerOverridesByProvider,
    state.provider,
    previewMode,
    workspaceId
  ]);

  useEffect(() => {
    if (previewMode) {
      return;
    }
    const nextWorkbenchState = projectDesktopAgentGUIWorkbenchState(state);
    if (
      areDesktopAgentGUIWorkbenchStatesEqual(workbenchState, nextWorkbenchState)
    ) {
      lastRequestedWorkbenchStateRef.current = workbenchState;
      return;
    }
    if (
      lastRequestedWorkbenchStateRef.current &&
      areDesktopAgentGUIWorkbenchStatesEqual(
        lastRequestedWorkbenchStateRef.current,
        nextWorkbenchState
      )
    ) {
      return;
    }
    lastRequestedWorkbenchStateRef.current = nextWorkbenchState;
    onStateChange(nextWorkbenchState);
  }, [onStateChange, previewMode, state, workbenchState]);

  const frame = context.node.frame;
  const desktopSize = useMemo(
    () => ({
      height: Math.max(frame.height, frame.y + frame.height),
      width: Math.max(frame.width, frame.x + frame.width)
    }),
    [frame.height, frame.width, frame.x, frame.y]
  );
  const composerFocusRequestSequence =
    context.activation?.type === workbenchFocusInputActivationType
      ? context.activation.sequence
      : null;

  return (
    <DesktopAgentGUIErrorBoundary
      nodeId={context.node.id}
      provider={state.provider}
      runtimeApi={runtimeApi}
      workspaceId={workspaceId}
    >
      <AgentGUI
        agentActivityRuntime={agentActivityRuntime}
        agentHostApi={agentHostApi}
        i18n={i18n}
        locale={locale}
        agentSettings={DESKTOP_AGENT_GUI_AGENT_SETTINGS}
        currentUserId="local"
        desktopSize={desktopSize}
        embedded
        height={frame.height}
        isMaximized={context.displayMode === "fullscreen"}
        isActive={context.isFocused}
        composerFocusRequestSequence={composerFocusRequestSequence}
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
        onClose={DESKTOP_AGENT_GUI_NOOP}
        onLinkAction={onLinkAction}
        onResize={DESKTOP_AGENT_GUI_NOOP}
        onShowMessage={DESKTOP_AGENT_GUI_NOOP}
        onUpdateNode={handleUpdateNode}
        onWorkspaceFileReferencesAdded={trackWorkspaceFileReferences}
        position={DESKTOP_AGENT_GUI_POSITION}
        previewMode={previewMode}
        richTextAtProviders={effectiveRichTextAtProviders}
        state={state}
        title={context.node.title}
        width={frame.width}
        workspaceFileReferenceAdapter={workspaceFileReferenceAdapter}
        workspaceAppIcons={workspaceAppIcons}
        workspaceId={workspaceId}
        workspacePath="/"
      />
    </DesktopAgentGUIErrorBoundary>
  );
}

function useDesktopManagedAgentsState(
  agentProviderStatusService: IAgentProviderStatusService | undefined
): AgentHostManagedAgentsState | null {
  const snapshot = useSyncExternalStore(
    agentProviderStatusService
      ? (listener) => agentProviderStatusService.subscribe(listener)
      : noopSubscribe,
    agentProviderStatusService
      ? () => agentProviderStatusService.getSnapshot()
      : getEmptyAgentProviderStatusSnapshot,
    getEmptyAgentProviderStatusSnapshot
  );

  useEffect(() => {
    if (!agentProviderStatusService) {
      return;
    }

    void ensureDesktopManagedAgentProviderStatuses(agentProviderStatusService);
  }, [agentProviderStatusService]);

  return useMemo(
    () =>
      agentProviderStatusService
        ? projectDesktopManagedAgentsState(snapshot)
        : null,
    [agentProviderStatusService, snapshot]
  );
}

function getEmptyAgentProviderStatusSnapshot(): AgentProviderStatusSnapshot {
  return EMPTY_AGENT_PROVIDER_STATUS_SNAPSHOT;
}

function noopSubscribe(): () => void {
  return () => {};
}
