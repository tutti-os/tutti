import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type {
  AgentActivityRuntime,
  AgentGUIProvider,
  AgentGUIProviderReadinessGate,
  AgentGUIProviderReadinessGateAction,
  AgentGUIProps
} from "@tutti-os/agent-gui";
import type { WorkbenchHostNodeBodyContext } from "@tutti-os/workbench-surface";
import type { DesktopComputerUseApi } from "@preload/types";
import {
  desktopComputerUseStatusesEqual,
  type DesktopComputerUseStatus
} from "@shared/contracts/ipc";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../services/agentProviderStatusService.interface";
import {
  desktopAccountRefreshProviders,
  ensureDesktopManagedAgentProviderStatuses,
  isDesktopManagedAgentProvider
} from "../services/internal/desktopManagedAgentProviders.ts";
import { projectDesktopAgentProviderReadinessGates } from "../services/internal/desktopAgentProviderReadinessGate.ts";
import { useAccountService } from "../../workspace-workbench/ui/useAccountService.ts";
import {
  activeProviderNotReadyRecheckKey,
  shouldSuppressAgentProviderNotReadyProjection
} from "./desktopAgentProviderNotReadyRecheck.ts";
import {
  getEmptyProviderStatusSnapshot,
  noopSubscribe,
  sessionEventLooksLikeAuthFailure
} from "./desktopAgentGUIWorkbenchModel.ts";

export function useDesktopAgentGUIReadiness(input: {
  agentActivityRuntime: AgentActivityRuntime;
  agentProviderStatusService?: IAgentProviderStatusService;
  computerUseApi?: Pick<DesktopComputerUseApi, "checkStatus">;
  host: WorkbenchHostNodeBodyContext["host"];
  provider: AgentGUIProvider | null;
  providerStatusBootstrapSnapshot?: AgentProviderStatusSnapshot | null;
  trackAgentProviderChatReady?: (input: { provider: string }) => Promise<void>;
  workspaceId: string;
}) {
  const {
    agentActivityRuntime,
    agentProviderStatusService,
    computerUseApi,
    host,
    provider,
    providerStatusBootstrapSnapshot,
    trackAgentProviderChatReady,
    workspaceId
  } = input;
  const { state: accountState } = useAccountService();
  const previousAccountLoginStatusRef = useRef<string | null>(null);
  const previousAccountUserIdRef = useRef<string | null>(null);
  const [computerUseStatus, setComputerUseStatus] =
    useState<DesktopComputerUseStatus | null>(null);
  useEffect(() => {
    if (!agentProviderStatusService || !provider) {
      return;
    }
    void ensureDesktopManagedAgentProviderStatuses(agentProviderStatusService, [
      provider
    ]);
  }, [agentProviderStatusService, provider]);
  const providerStatusSnapshot = useSyncExternalStore(
    agentProviderStatusService
      ? (listener) => agentProviderStatusService.subscribe(listener)
      : noopSubscribe,
    agentProviderStatusService
      ? () => agentProviderStatusService.getSnapshot()
      : getEmptyProviderStatusSnapshot,
    getEmptyProviderStatusSnapshot
  );
  const effectiveProviderStatusSnapshot =
    !providerStatusSnapshot.capturedAt && providerStatusBootstrapSnapshot
      ? providerStatusBootstrapSnapshot
      : providerStatusSnapshot;
  const activeProviderAvailabilityStatus = provider
    ? (effectiveProviderStatusSnapshot.statuses.find(
        (status) => status.provider === provider
      )?.availability.status ?? null)
    : null;
  const activeProviderRecheckKey = provider
    ? activeProviderNotReadyRecheckKey({
        availabilityStatus: activeProviderAvailabilityStatus,
        provider
      })
    : null;
  const [settledActiveProviderRecheckKey, setSettledActiveProviderRecheckKey] =
    useState<string | null>(null);
  const activeProviderRecheckGenerationRef = useRef(0);
  const suppressNotReadyProjection =
    shouldSuppressAgentProviderNotReadyProjection({
      recheckKey: activeProviderRecheckKey,
      settledRecheckKey: settledActiveProviderRecheckKey
    });
  useEffect(() => {
    if (!agentProviderStatusService || !provider) {
      setSettledActiveProviderRecheckKey(null);
      return;
    }
    if (activeProviderRecheckKey === null) {
      setSettledActiveProviderRecheckKey(null);
      return;
    }
    if (settledActiveProviderRecheckKey === activeProviderRecheckKey) {
      return;
    }
    const generation = ++activeProviderRecheckGenerationRef.current;
    const recheckKey = activeProviderRecheckKey;
    void agentProviderStatusService.refresh([provider]).finally(() => {
      if (activeProviderRecheckGenerationRef.current === generation) {
        setSettledActiveProviderRecheckKey(recheckKey);
      }
    });
    return () => {
      activeProviderRecheckGenerationRef.current += 1;
    };
  }, [
    activeProviderRecheckKey,
    agentProviderStatusService,
    provider,
    settledActiveProviderRecheckKey
  ]);
  // Activation funnel stage ③ "saw a chattable surface": the agent workbench
  // body is mounted (not a dock preview) and the active provider is ready, so
  // the composer is interactive. reportProviderReady (stage ②) can fire while
  // no agent surface is open; this fires only when the user is actually here.
  const isActiveAgentProviderChatReady =
    provider !== null &&
    agentProviderStatusService?.getStatus(provider)?.availability.status ===
      "ready";
  const chatReadyReportedProvidersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      !isActiveAgentProviderChatReady ||
      !trackAgentProviderChatReady ||
      !provider
    ) {
      return;
    }
    if (chatReadyReportedProvidersRef.current.has(provider)) {
      return;
    }
    chatReadyReportedProvidersRef.current.add(provider);
    void trackAgentProviderChatReady({ provider });
  }, [isActiveAgentProviderChatReady, provider, trackAgentProviderChatReady]);
  // When a turn fails authentication (a dropped login the daemon now flags), the
  // status is pull-based, so re-probe immediately to flip the dock/wizard to
  // "needs login" without the user having to re-detect manually.
  useEffect(() => {
    if (!agentProviderStatusService || !provider) {
      return;
    }
    return agentActivityRuntime.subscribeSessionEvents(workspaceId, (event) => {
      if (sessionEventLooksLikeAuthFailure(event)) {
        void agentProviderStatusService.refresh([provider]);
      }
    });
  }, [agentActivityRuntime, agentProviderStatusService, provider, workspaceId]);
  useEffect(() => {
    if (!computerUseApi) {
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
    // Permission changes usually happen in System Settings; refresh as soon
    // as the user comes back instead of waiting for the next interval tick.
    let lastVisibilityRefreshAt = 0;
    const refreshOnVisibility = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const now = Date.now();
      if (now - lastVisibilityRefreshAt < 5_000) {
        return;
      }
      lastVisibilityRefreshAt = now;
      refreshComputerUseStatus();
    };
    window.addEventListener("focus", refreshOnVisibility);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      canceled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnVisibility);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [computerUseApi]);
  const handleAgentProviderLogin = useCallback(
    (
      loginProvider: Parameters<
        NonNullable<AgentGUIProps["hostActions"]["onAgentProviderLogin"]>
      >[0]
    ) => {
      if (!isDesktopManagedAgentProvider(loginProvider)) {
        return;
      }
      void agentProviderStatusService?.runAction(loginProvider, "login", {
        context: { workbenchHost: host, workspaceId },
        origin: "user"
      });
    },
    [agentProviderStatusService, host, workspaceId]
  );
  const accountUserId = accountState.user?.user_id ?? null;
  useEffect(() => {
    const previousLoginStatus = previousAccountLoginStatusRef.current;
    const previousUserId = previousAccountUserIdRef.current;
    previousAccountLoginStatusRef.current = accountState.loginStatus;
    previousAccountUserIdRef.current = accountUserId;
    const loginCompletedChanged =
      previousLoginStatus === "completed" ||
      accountState.loginStatus === "completed";
    const signedInUserChanged =
      previousUserId !== accountUserId &&
      (previousUserId !== null || accountUserId !== null);
    if (!loginCompletedChanged && !signedInUserChanged) {
      return;
    }
    if (desktopAccountRefreshProviders.length > 0) {
      void agentProviderStatusService?.refresh([
        ...desktopAccountRefreshProviders
      ]);
    }
  }, [accountState.loginStatus, accountUserId, agentProviderStatusService]);
  const handleProviderReadinessGateAction = useCallback(
    (
      actionProvider: AgentGUIProvider,
      action: AgentGUIProviderReadinessGateAction
    ) => {
      if (!isDesktopManagedAgentProvider(actionProvider)) {
        return;
      }
      if (action === "refresh") {
        void agentProviderStatusService?.refresh([actionProvider]);
        return;
      }
      void agentProviderStatusService?.runAction(actionProvider, action, {
        context: { workbenchHost: host, workspaceId },
        origin: "user"
      });
    },
    [agentProviderStatusService, host, workspaceId]
  );
  const providerReadinessGates = useMemo(() => {
    const gates = projectDesktopAgentProviderReadinessGates({
      snapshot: effectiveProviderStatusSnapshot,
      onAction: handleProviderReadinessGateAction
    });
    if (!suppressNotReadyProjection) {
      return gates;
    }
    const checkingGate: AgentGUIProviderReadinessGate = {
      status: "checking",
      pendingAction: null
    };
    return provider ? { ...gates, [provider]: checkingGate } : gates;
  }, [
    effectiveProviderStatusSnapshot,
    handleProviderReadinessGateAction,
    provider,
    suppressNotReadyProjection
  ]);
  return {
    computerUseStatus,
    handleAgentProviderLogin,
    provider,
    providerReadinessGates,
    providerStatusSnapshot
  };
}
