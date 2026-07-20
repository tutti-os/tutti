import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type {
  AgentProviderStatusActionContext,
  AgentProviderStatusActionOptions,
  AgentProviderStatusSnapshot,
  AgentProviderTerminalCommandRunner,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface";
import {
  INotificationService,
  type NotificationService
} from "@tutti-os/ui-notifications";
import { translate } from "../../../../i18n/appRuntime.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { resolveDesktopErrorMessage } from "../../../../lib/desktopErrors.ts";
import { AgentAnalyticsErrorCode } from "../../../analytics/reporters/agent-error-fields.ts";
import { applyDesktopAgentProviderRuntimeProbeFallbacks } from "./desktopAgentProviderRuntimeProbeFallback.ts";
import {
  DesktopAgentProviderLoginLifecycle,
  type AgentProviderStatusPollScheduler
} from "./desktopAgentProviderLoginLifecycle.ts";
import {
  resolveAgentProviderInstallErrorMessage,
  runInstalledProviderAction,
  shouldTrackPendingAction
} from "./desktopAgentProviderInstall.ts";
import {
  normalizeAgentProviderActionOptions,
  providerStatusRequestKey,
  unrefAgentProviderTimer,
  withAgentProviderRequestTimeout
} from "./desktopAgentProviderStatusServiceSupport.ts";
import { reconcileProviderStatuses } from "./desktopAgentProviderStatusCatalog.ts";
import {
  DesktopAgentProviderStatusDiagnostics,
  type DiagnosticsConsentStore
} from "./desktopAgentProviderStatusDiagnostics.ts";

export type { DiagnosticsConsentStore } from "./desktopAgentProviderStatusDiagnostics.ts";

export interface DesktopAgentProviderStatusServiceDependencies {
  accountLogin?: { startLogin(): Promise<void> };
  loginStatusPollDurationMs?: number;
  loginStatusPollIntervalMs?: number;
  loginStatusPollScheduler?: AgentProviderStatusPollScheduler;
  tuttidClient: TuttidClient;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  diagnosticsConsentStore?: DiagnosticsConsentStore;
  diagnosticNow?: () => number;
  requestTimeoutMs?: number;
  runtimeApi?: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
}

type AgentProviderStatusPollTimer = number | { unref?: () => void };

const defaultRequestTimeoutMs = 15_000;
const pendingInstallStatusPollIntervalMs = 1_000;

const defaultLoginStatusPollScheduler: AgentProviderStatusPollScheduler = {
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs)
};

const emptySnapshot: AgentProviderStatusSnapshot = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
};

export class DesktopAgentProviderStatusService implements IAgentProviderStatusService {
  readonly _serviceBrand = undefined;

  private readonly dependencies: DesktopAgentProviderStatusServiceDependencies;
  private readonly diagnostics: DesktopAgentProviderStatusDiagnostics;
  private readonly notifications: NotificationService;
  private readonly inflightRequests = new Map<
    string,
    Promise<AgentProviderStatusListResponse | null>
  >();
  private readonly loginLifecycle: DesktopAgentProviderLoginLifecycle;
  private readonly pendingActionStatusPolls = new Map<
    string,
    AgentProviderStatusPollTimer
  >();
  private requestSequence = 0;
  private latestWildcardRequestId = 0;
  private readonly latestRequestIdByProvider = new Map<
    WorkspaceAgentProvider,
    number
  >();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private snapshot: AgentProviderStatusSnapshot = emptySnapshot;
  private readonly transientDowngradeCounts = new Map<string, number>();
  private disposed = false;

  constructor(
    dependencies: DesktopAgentProviderStatusServiceDependencies,
    notifications: NotificationService = noopNotifications
  ) {
    this.dependencies = dependencies;
    this.notifications = notifications;
    this.diagnostics = new DesktopAgentProviderStatusDiagnostics({
      consentStore: dependencies.diagnosticsConsentStore,
      now: dependencies.diagnosticNow,
      reporterNow: dependencies.reporterNow,
      reporterService: dependencies.reporterService,
      runtimeApi: dependencies.runtimeApi
    });
    this.loginLifecycle = new DesktopAgentProviderLoginLifecycle({
      loginStatusPollDurationMs: dependencies.loginStatusPollDurationMs,
      loginStatusPollIntervalMs: dependencies.loginStatusPollIntervalMs,
      loginStatusPollScheduler: dependencies.loginStatusPollScheduler,
      refresh: async (provider) => this.refresh([provider]),
      reportNodeResult: (input) => this.diagnostics.reportNodeResult(input),
      reporterNow: dependencies.reporterNow,
      reporterService: dependencies.reporterService
    });
  }

  getRevision(): number {
    return this.revision;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.requestSequence += 1;
    for (const timer of this.pendingActionStatusPolls.values()) {
      this.loginStatusPollScheduler.clearTimeout(timer);
    }
    this.pendingActionStatusPolls.clear();
    this.loginLifecycle.dispose();
    this.listeners.clear();
  }

  getSnapshot(): AgentProviderStatusSnapshot {
    return this.snapshot;
  }

  getStatus(provider: WorkspaceAgentProvider): AgentProviderStatus | null {
    return (
      this.snapshot.statuses.find((status) => status.provider === provider) ??
      null
    );
  }

  hydrate(snapshot: AgentProviderStatusSnapshot): void {
    // Only seed from a bootstrap snapshot before this instance has ever
    // captured its own data — otherwise a stale hand-off (or one that raced
    // with a real response) could regress already-loaded local state.
    if (this.snapshot.capturedAt) {
      return;
    }
    this.setSnapshot(snapshot);
  }

  isActionPending(provider: WorkspaceAgentProvider, actionId: string): boolean {
    return this.snapshot.pendingActions.some(
      (action) => action.provider === provider && action.actionId === actionId
    );
  }

  async ensureLoaded(
    input: {
      providers?: WorkspaceAgentProvider[];
      includeNetwork?: boolean;
    } = {}
  ): Promise<AgentProviderStatusListResponse | null> {
    if (this.hasLoadedProviderSnapshot(input.providers)) {
      this.diagnostics.logStatusRequestCacheHit(
        input,
        this.snapshot.statuses.length
      );
      return this.snapshotResponse();
    }

    const requestKey = providerStatusRequestKey(input);
    const inflightRequest = this.inflightRequests.get(requestKey);
    if (inflightRequest) {
      this.diagnostics.logStatusRequestReused(input);
      await inflightRequest;
      if (this.hasLoadedProviderSnapshot(input.providers)) {
        return this.snapshotResponse();
      }
    }

    return this.requestStatuses(input);
  }

  private async requestStatuses(
    input: {
      providers?: WorkspaceAgentProvider[];
      includeNetwork?: boolean;
      refresh?: boolean;
    } = {}
  ): Promise<AgentProviderStatusListResponse | null> {
    const requestKey = providerStatusRequestKey(input);
    const inflightRequest = this.inflightRequests.get(requestKey);
    if (inflightRequest) {
      this.diagnostics.logStatusRequestReused(input);
      return inflightRequest;
    }

    this.setSnapshot({
      ...this.snapshot,
      error: null,
      isLoading: true
    });

    const requestId = this.requestSequence + 1;
    this.requestSequence = requestId;
    this.markLatestStatusRequest(input.providers, requestId);
    const requestStartedAt = this.diagnostics.logStatusRequestStarted({
      request: input,
      requestId
    });
    const request = withAgentProviderRequestTimeout(
      this.dependencies.tuttidClient.getAgentProviderStatuses(input),
      this.dependencies.requestTimeoutMs ?? defaultRequestTimeoutMs
    )
      .then(async (response) => {
        const maybeProbedStatuses =
          applyDesktopAgentProviderRuntimeProbeFallbacks({
            probeProvider: (provider) =>
              this.dependencies.tuttidClient.probeAgentProvider(provider),
            requestedProviders: input.providers,
            statuses: response.providers
          });
        const probedStatuses = Array.isArray(maybeProbedStatuses)
          ? maybeProbedStatuses
          : await maybeProbedStatuses;
        const currentResponseStatuses = probedStatuses.filter((status) =>
          this.isLatestStatusRequest(status.provider, requestId)
        );
        let responseProviders = [...this.snapshot.statuses];
        if (currentResponseStatuses.length > 0) {
          const previousStatuses = this.snapshot.statuses;
          const appliedProviders = currentResponseStatuses.map(
            (status) => status.provider
          );
          const reconciledStatuses = reconcileProviderStatuses({
            previousStatuses,
            requestedProviders: appliedProviders,
            responseStatuses: currentResponseStatuses,
            transientDowngradeCounts: this.transientDowngradeCounts
          });
          responseProviders = [...reconciledStatuses];
          this.setSnapshot({
            capturedAt: response.capturedAt,
            defaultProvider: response.defaultProvider,
            error: null,
            isLoading: this.inflightRequests.size > 1,
            pendingActions: this.snapshot.pendingActions,
            statuses: reconciledStatuses
          });
          this.diagnostics.logActiveActionSnapshotDiagnostics(
            reconciledStatuses,
            (provider) => this.isActionPending(provider, "install")
          );
          // Report provider_ready before reportCompletedLoginResults so the
          // pendingLoginResults set is still populated when we classify how a
          // provider became ready (login vs. already-ready vs. external).
          this.loginLifecycle.reportProviderReadyTransitions(
            previousStatuses,
            reconciledStatuses
          );
          this.diagnostics.reportEnvDetectedChanges(reconciledStatuses);
          void this.loginLifecycle.reportCompletedLoginResults(
            response.providers
          );
        }
        const durationMs = this.diagnostics.logStatusRequestResolved({
          appliedProviderCount: currentResponseStatuses.length,
          request: input,
          requestId,
          responseProviderCount: response.providers.length,
          staleProviderCount:
            response.providers.length - currentResponseStatuses.length,
          startedAt: requestStartedAt
        });
        await this.diagnostics.reportNodeResult({
          durationMs,
          flow: "provider_setup",
          node: "provider_status_request",
          provider: input.providers?.[0] ?? response.defaultProvider ?? null,
          success: true
        });
        return {
          ...response,
          providers: responseProviders
        };
      })
      .catch(async (error: unknown) => {
        if (this.isCurrentStatusRequest(input.providers, requestId)) {
          this.setSnapshot({
            ...this.snapshot,
            error: resolveDesktopErrorMessage(error, getActiveLocale()),
            isLoading: this.inflightRequests.size > 1
          });
        }
        const durationMs = this.diagnostics.logStatusRequestFailed({
          error,
          request: input,
          requestId,
          startedAt: requestStartedAt
        });
        await this.diagnostics.reportNodeResult({
          durationMs,
          error,
          fallbackErrorCode: AgentAnalyticsErrorCode.ProviderStatusFailed,
          flow: "provider_setup",
          node: "provider_status_request",
          provider: input.providers?.[0] ?? null,
          success: false
        });
        return null;
      })
      .finally(() => {
        if (this.inflightRequests.get(requestKey) === request) {
          this.inflightRequests.delete(requestKey);
        }
        if (this.inflightRequests.size === 0 && this.snapshot.isLoading) {
          this.setSnapshot({ ...this.snapshot, isLoading: false });
        }
      });

    this.inflightRequests.set(requestKey, request);
    return request;
  }

  async runAction(
    provider: WorkspaceAgentProvider,
    actionId: string,
    input:
      | AgentProviderStatusActionOptions
      | AgentProviderStatusActionContext = {}
  ): Promise<void> {
    const options = normalizeAgentProviderActionOptions(input);
    const isLoginAction = actionId === "login";

    let action = this.findAction(provider, actionId);
    if (!action) {
      await this.refresh([provider]);
      action = this.findAction(provider, actionId);
      if (!action) {
        this.notifyMissingAction(actionId);
        if (isLoginAction) {
          await this.loginLifecycle.reportLoginResult(
            provider,
            false,
            "action_unavailable",
            "Agent provider login action is unavailable.",
            AgentAnalyticsErrorCode.LoginLaunchFailed
          );
        }
        return;
      }
    }
    if (action.kind === "refresh") {
      await this.refresh([provider]);
      if (isLoginAction) {
        await this.loginLifecycle.reportLoginResult(
          provider,
          false,
          "unsupported_action",
          "Agent provider login action is unsupported.",
          AgentAnalyticsErrorCode.LoginLaunchFailed
        );
      }
      return;
    }

    const loginAttempt = isLoginAction
      ? this.loginLifecycle.beginLogin(provider, options.origin ?? "user")
      : null;
    if (loginAttempt?.kind === "reuse") {
      this.diagnostics.logRendererDiagnostic(
        "agent_provider_login.attempt_reused",
        { origin: options.origin ?? "user", provider }
      );
      return;
    }
    if (loginAttempt?.kind === "start") {
      this.diagnostics.logRendererDiagnostic(
        loginAttempt.replaced
          ? "agent_provider_login.attempt_replaced"
          : "agent_provider_login.attempt_started",
        { origin: options.origin ?? "user", provider }
      );
    }
    const trackPendingAction =
      shouldTrackPendingAction(action.id) || isLoginAction;
    if (trackPendingAction) {
      this.addPendingAction(provider, actionId);
    }
    try {
      if (isLoginAction) {
        await this.loginLifecycle.reportLoginInitiated(provider);
      }
      if (action.id === "install") {
        await runInstalledProviderAction(
          this.dependencies.tuttidClient,
          provider
        );
        await this.refresh([provider]);
        await this.diagnostics.reportNodeResult({
          flow: "provider_setup",
          node: "install_action_requested",
          provider,
          success: true
        });
        return;
      }

      if (isLoginAction && action.kind === "daemon_action") {
        if (!this.dependencies.accountLogin) {
          throw new Error("Account login is unavailable.");
        }
        await this.dependencies.accountLogin.startLogin();
        this.loginLifecycle.registerLoginTerminal(
          provider,
          loginAttempt?.kind === "start" ? loginAttempt.generation : 0,
          undefined
        );
        return;
      }

      if (!action.command) {
        if (isLoginAction) {
          if (loginAttempt?.kind === "start") {
            this.loginLifecycle.failLoginLaunch(
              provider,
              loginAttempt.generation
            );
          }
          await this.loginLifecycle.reportLoginResult(
            provider,
            false,
            "command_missing",
            "Agent provider login command is missing.",
            AgentAnalyticsErrorCode.LoginLaunchFailed
          );
        }
        return;
      }

      const terminalLaunchStartedAt = this.loginLifecycle.now();
      const terminal =
        await this.dependencies.terminalCommandRunner.runTerminalCommand(
          action.command,
          options.context
        );
      if (isLoginAction) {
        await this.diagnostics.reportNodeResult({
          durationMs: this.loginLifecycle.now() - terminalLaunchStartedAt,
          flow: "provider_setup",
          node: "login_terminal_launch",
          provider,
          success: true
        });
        this.loginLifecycle.registerLoginTerminal(
          provider,
          loginAttempt?.kind === "start" ? loginAttempt.generation : 0,
          terminal
        );
      }
      void this.refresh([provider]);
    } catch (error) {
      if (action.id === "install") {
        this.notifications.error({
          description: resolveAgentProviderInstallErrorMessage(error),
          title: translate(
            "workspace.workbenchDesktop.agentProviders.installFailed"
          )
        });
        await this.diagnostics.reportNodeResult({
          error,
          fallbackErrorCode: AgentAnalyticsErrorCode.InstallFailed,
          flow: "provider_setup",
          node: "install_action_requested",
          provider,
          success: false
        });
      }
      if (action.id === "login") {
        if (loginAttempt?.kind === "start") {
          this.loginLifecycle.failLoginLaunch(
            provider,
            loginAttempt.generation
          );
        }
        this.notifications.error({
          description: resolveDesktopErrorMessage(error, getActiveLocale()),
          title: translate(
            "workspace.workbenchDesktop.agentProviders.loginFailed"
          )
        });
        await this.loginLifecycle.reportLoginResult(
          provider,
          false,
          "launch_failed",
          error,
          AgentAnalyticsErrorCode.LoginLaunchFailed
        );
        await this.diagnostics.reportNodeResult({
          error,
          fallbackErrorCode: AgentAnalyticsErrorCode.LoginLaunchFailed,
          flow: "provider_setup",
          node: "login_terminal_launch",
          provider,
          success: false
        });
      }
      throw error;
    } finally {
      if (trackPendingAction) {
        this.removePendingAction(provider, actionId);
      }
    }
  }

  async refresh(
    providers?: WorkspaceAgentProvider[],
    options?: { includeNetwork?: boolean }
  ): Promise<void> {
    const input = {
      providers,
      includeNetwork: options?.includeNetwork,
      refresh: true
    };
    const inflightRequest = this.inflightRequests.get(
      providerStatusRequestKey({
        providers,
        includeNetwork: options?.includeNetwork
      })
    );
    if (inflightRequest) {
      await inflightRequest;
    }
    await this.requestStatuses(input);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setSnapshot(snapshot: AgentProviderStatusSnapshot): void {
    this.snapshot = snapshot;
    this.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private findAction(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): AgentProviderStatus["actions"][number] | null {
    return (
      this.getStatus(provider)?.actions.find((item) => item.id === actionId) ??
      null
    );
  }

  private hasLoadedProviderSnapshot(
    providers: readonly WorkspaceAgentProvider[] | undefined
  ): boolean {
    if (!this.snapshot.capturedAt || !this.snapshot.defaultProvider) {
      return false;
    }
    if (!providers || providers.length === 0) {
      return true;
    }
    const knownProviders = new Set(
      this.snapshot.statuses.map((status) => status.provider)
    );
    return providers.every((provider) => knownProviders.has(provider));
  }

  private snapshotResponse(): AgentProviderStatusListResponse {
    if (!this.snapshot.defaultProvider) {
      throw new Error("agent_provider_status.default_provider_required");
    }
    return {
      capturedAt: this.snapshot.capturedAt ?? "",
      defaultProvider: this.snapshot.defaultProvider,
      providers: [...this.snapshot.statuses]
    };
  }

  private notifyMissingAction(actionId: string): void {
    if (actionId !== "login") {
      return;
    }
    this.notifications.error({
      title: translate("workspace.workbenchDesktop.agentProviders.loginFailed")
    });
  }

  private markLatestStatusRequest(
    providers: readonly WorkspaceAgentProvider[] | undefined,
    requestId: number
  ): void {
    if (!providers || providers.length === 0) {
      this.latestWildcardRequestId = requestId;
      return;
    }
    for (const provider of providers) {
      this.latestRequestIdByProvider.set(provider, requestId);
    }
  }

  private isLatestStatusRequest(
    provider: WorkspaceAgentProvider,
    requestId: number
  ): boolean {
    return (
      requestId >= this.latestWildcardRequestId &&
      requestId >= (this.latestRequestIdByProvider.get(provider) ?? 0)
    );
  }

  private isCurrentStatusRequest(
    providers: readonly WorkspaceAgentProvider[] | undefined,
    requestId: number
  ): boolean {
    if (!providers || providers.length === 0) {
      return requestId >= this.latestWildcardRequestId;
    }
    return providers.some((provider) =>
      this.isLatestStatusRequest(provider, requestId)
    );
  }

  private addPendingAction(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): void {
    if (this.isActionPending(provider, actionId)) {
      return;
    }
    this.diagnostics.logRendererDiagnostic(
      "agent_provider_status.pending_action_added",
      {
        actionId,
        provider
      }
    );
    this.setSnapshot({
      ...this.snapshot,
      pendingActions: [...this.snapshot.pendingActions, { actionId, provider }]
    });
    this.startPendingActionStatusPolling(provider, actionId);
  }

  private removePendingAction(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): void {
    const pendingActions = this.snapshot.pendingActions.filter(
      (action) => action.provider !== provider || action.actionId !== actionId
    );
    if (pendingActions.length === this.snapshot.pendingActions.length) {
      return;
    }
    this.diagnostics.logRendererDiagnostic(
      "agent_provider_status.pending_action_removed",
      {
        actionId,
        provider
      }
    );
    this.stopPendingActionStatusPolling(provider, actionId);
    this.setSnapshot({
      ...this.snapshot,
      pendingActions
    });
  }

  private get loginStatusPollScheduler(): AgentProviderStatusPollScheduler {
    return (
      this.dependencies.loginStatusPollScheduler ??
      defaultLoginStatusPollScheduler
    );
  }

  private startPendingActionStatusPolling(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): void {
    if (actionId !== "install") {
      return;
    }
    this.schedulePendingActionStatusPoll(provider, actionId);
  }

  private schedulePendingActionStatusPoll(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): void {
    if (this.disposed || !this.isActionPending(provider, actionId)) {
      return;
    }
    const key = pendingActionKey(provider, actionId);
    if (this.pendingActionStatusPolls.has(key)) {
      return;
    }
    const timer = this.loginStatusPollScheduler.setTimeout(() => {
      this.pendingActionStatusPolls.delete(key);
      void this.runPendingActionStatusPoll(provider, actionId);
    }, pendingInstallStatusPollIntervalMs);
    this.pendingActionStatusPolls.set(key, timer);
    unrefAgentProviderTimer(timer);
  }

  private async runPendingActionStatusPoll(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): Promise<void> {
    if (!this.isActionPending(provider, actionId)) {
      return;
    }
    await this.refresh([provider]);
    this.schedulePendingActionStatusPoll(provider, actionId);
  }

  private stopPendingActionStatusPolling(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): void {
    const key = pendingActionKey(provider, actionId);
    const timer = this.pendingActionStatusPolls.get(key);
    if (timer === undefined) {
      return;
    }
    this.loginStatusPollScheduler.clearTimeout(timer);
    this.pendingActionStatusPolls.delete(key);
  }

  getDiagnosticsConsent(): boolean {
    return this.diagnostics.getDiagnosticsConsent();
  }

  setDiagnosticsConsent(value: boolean): void {
    this.diagnostics.setDiagnosticsConsent(value);
  }

  // The consent-gated "report problem" action: sends the fuller diagnostic
  // payload, but only when the user has agreed.
  async reportEnvIssue(provider: WorkspaceAgentProvider): Promise<void> {
    await this.diagnostics.reportEnvIssue(this.getStatus(provider));
  }
}

function pendingActionKey(
  provider: WorkspaceAgentProvider,
  actionId: string
): string {
  return `${provider}:${actionId}`;
}

// Avoid decorator syntax so the renderer Babel pass can parse this file.
INotificationService(DesktopAgentProviderStatusService, undefined, 1);

const noopNotifications: NotificationService = {
  _serviceBrand: undefined,
  error() {},
  info() {},
  notify() {},
  success() {},
  warning() {}
};
