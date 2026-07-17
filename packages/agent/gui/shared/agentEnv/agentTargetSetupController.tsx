import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode
} from "react";
import { toast } from "@tutti-os/ui-system";
import { useOptionalAgentHostApi } from "../../agentActivityHost.tsx";
import type {
  AgentHostAgentTargetSetupState,
  AgentHostAgentTargetSetupWatch,
  AgentHostToastApi
} from "../../host/agentHostApi.ts";
import { useTranslation } from "../../i18n/index.ts";
import type { AgentGUIAgentTarget } from "../../types.ts";
import {
  createAgentTargetSetupFailureNotificationController,
  type AgentTargetSetupFailureNotification
} from "./agentTargetSetupNotificationController.ts";

const DISABLED_SETUP_STATE: AgentHostAgentTargetSetupState = {
  snapshot: null,
  loading: false,
  failed: false
};

export interface AgentTargetSetupControllerState {
  agentTarget: AgentGUIAgentTarget | null;
  agentTargetId: string;
  authenticatePending: boolean;
  dialogOpen: boolean;
  enabled: boolean;
  installPending: boolean;
  selectedAuthMethodId: string | null;
  setup: AgentHostAgentTargetSetupState;
}

export interface AgentTargetSetupController {
  authenticate(methodId: string): Promise<void>;
  getSnapshot(): AgentTargetSetupControllerState;
  install(planDigest: string): Promise<void>;
  refresh(): Promise<void>;
  selectAuthMethod(methodId: string): void;
  setDialogOpen(open: boolean): void;
  subscribe(listener: () => void): () => void;
}

const AgentTargetSetupControllerContext =
  createContext<AgentTargetSetupController | null>(null);

export function AgentTargetSetupControllerProvider({
  children,
  controller
}: {
  children: ReactNode;
  controller: AgentTargetSetupController;
}): React.JSX.Element {
  return (
    <AgentTargetSetupControllerContext.Provider value={controller}>
      {children}
    </AgentTargetSetupControllerContext.Provider>
  );
}

export function useAgentTargetSetupController(): AgentTargetSetupController {
  const controller = useContext(AgentTargetSetupControllerContext);
  if (!controller) {
    throw new Error("AgentTargetSetupControllerProvider is missing.");
  }
  return controller;
}

export function useCreateAgentTargetSetupController(
  agentTarget: AgentGUIAgentTarget | null
): AgentTargetSetupController {
  const hostApi = useOptionalAgentHostApi();
  const { t } = useTranslation();
  const agentTargetId =
    agentTarget?.agentTargetId?.trim() || agentTarget?.targetId.trim() || "";
  const enabled =
    agentTarget?.ref.setupKind === "target_runtime" &&
    Boolean(hostApi?.agentTargetSetup && agentTargetId);
  const stableAgentTarget = useMemo(
    () => agentTarget,
    [
      agentTargetId,
      agentTarget?.label,
      agentTarget?.provider,
      agentTarget?.ref.setupKind
    ]
  );
  const watch = useMemo(
    () =>
      enabled
        ? (hostApi?.agentTargetSetup?.watch({ agentTargetId }) ?? null)
        : null,
    [agentTargetId, enabled, hostApi?.agentTargetSetup]
  );
  const showNotification = useCallback(
    (notification: AgentTargetSetupFailureNotification) =>
      showTargetSetupFailureNotification({
        hostToast: hostApi?.toast,
        notification,
        t
      }),
    [hostApi?.toast, t]
  );
  const logCommandError = useCallback(
    (command: "authenticate" | "install", error: unknown) => {
      hostApi?.debug?.logRuntimeDiagnostics({
        agentTargetId,
        error: error instanceof Error ? error.message : String(error),
        event:
          command === "install"
            ? "agent-target-runtime-install-failed"
            : "agent-target-runtime-authentication-failed"
      });
    },
    [agentTargetId, hostApi?.debug]
  );
  const controllerRef = useRef<{
    controller: AgentTargetSetupController;
    targetKey: string;
  } | null>(null);
  const targetKey = enabled ? agentTargetId : "";
  const controllerEntry = useMemo(() => {
    const previousState =
      controllerRef.current?.targetKey === targetKey
        ? controllerRef.current.controller.getSnapshot()
        : null;
    return {
      controller: createAgentTargetSetupController({
        agentTarget: stableAgentTarget,
        agentTargetId,
        enabled,
        initialDialogOpen: previousState?.dialogOpen ?? false,
        initialSelectedAuthMethodId:
          previousState?.selectedAuthMethodId ?? null,
        logCommandError,
        onNotification: showNotification,
        watch
      }),
      targetKey
    };
  }, [
    agentTargetId,
    enabled,
    logCommandError,
    showNotification,
    stableAgentTarget,
    targetKey,
    watch
  ]);
  controllerRef.current = controllerEntry;
  return controllerEntry.controller;
}

function createAgentTargetSetupController(input: {
  agentTarget: AgentGUIAgentTarget | null;
  agentTargetId: string;
  enabled: boolean;
  initialDialogOpen: boolean;
  initialSelectedAuthMethodId: string | null;
  logCommandError: (
    command: "authenticate" | "install",
    error: unknown
  ) => void;
  onNotification: (notification: AgentTargetSetupFailureNotification) => void;
  watch: AgentHostAgentTargetSetupWatch | null;
}): AgentTargetSetupController {
  const listeners = new Set<() => void>();
  const initialSetup = input.watch?.getSnapshot() ?? DISABLED_SETUP_STATE;
  const notifications =
    createAgentTargetSetupFailureNotificationController(initialSetup);
  let unsubscribe: (() => void) | null = null;
  let disposeGeneration = 0;
  let state: AgentTargetSetupControllerState = {
    agentTarget: input.agentTarget,
    agentTargetId: input.agentTargetId,
    authenticatePending: false,
    dialogOpen: input.initialDialogOpen,
    enabled: input.enabled,
    installPending: false,
    selectedAuthMethodId: input.initialSelectedAuthMethodId,
    setup: initialSetup
  };
  const update = (patch: Partial<AgentTargetSetupControllerState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const runCommand = async (
    command: "authenticate" | "install",
    operation: () => Promise<void>
  ) => {
    const pendingKey =
      command === "install" ? "installPending" : "authenticatePending";
    update({ [pendingKey]: true });
    try {
      await operation();
    } catch (error) {
      input.logCommandError(command, error);
    } finally {
      update({ [pendingKey]: false });
    }
  };
  return {
    authenticate: (methodId) =>
      runCommand(
        "authenticate",
        () =>
          input.watch?.authenticate({
            methodId,
            clientActionId: createClientActionId()
          }) ?? Promise.resolve()
      ),
    getSnapshot: () => state,
    install: (planDigest) =>
      runCommand(
        "install",
        () =>
          input.watch?.install({
            planDigest,
            clientActionId: createClientActionId()
          }) ?? Promise.resolve()
      ),
    refresh: () => input.watch?.refresh() ?? Promise.resolve(),
    selectAuthMethod: (selectedAuthMethodId) =>
      update({ selectedAuthMethodId }),
    setDialogOpen: (dialogOpen) => update({ dialogOpen }),
    subscribe(listener) {
      listeners.add(listener);
      disposeGeneration += 1;
      if (!unsubscribe && input.watch) {
        unsubscribe = input.watch.subscribe((setup) => {
          const notification = notifications.observe(setup);
          if (notification) input.onNotification(notification);
          update({ setup });
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          const scheduledGeneration = ++disposeGeneration;
          queueMicrotask(() => {
            if (
              listeners.size === 0 &&
              disposeGeneration === scheduledGeneration
            ) {
              unsubscribe?.();
              unsubscribe = null;
            }
          });
        }
      };
    }
  };
}

function showTargetSetupFailureNotification(input: {
  hostToast: AgentHostToastApi | undefined;
  notification: AgentTargetSetupFailureNotification;
  t: ReturnType<typeof useTranslation>["t"];
}): void {
  const title =
    input.notification.actionKind === "authenticate"
      ? input.t("agentHost.agentGui.targetSetupAuthFailed")
      : input.t("agentHost.agentGui.targetSetupFailed");
  if (input.hostToast?.error) {
    input.hostToast.error(title, input.notification.errorMessage);
    return;
  }
  toast.error(title, {
    description: input.notification.errorMessage,
    id: `agent-target-setup-${input.notification.actionId}`
  });
}

function createClientActionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `agent-setup-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
