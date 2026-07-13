import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import { AgentEnvDetectedReporter } from "../../../analytics/reporters/agent-env-detected/agentEnvDetectedReporter.ts";
import { AgentEnvIssueReportedReporter } from "../../../analytics/reporters/agent-env-issue-reported/agentEnvIssueReportedReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  buildEnvDetectedParams,
  buildEnvIssueParams,
  envDetectedSignature
} from "./agentEnvTelemetry.ts";
import type {
  AgentProviderStatusActionContext,
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
import {
  getAgentDiagnosticsConsent,
  setAgentDiagnosticsConsent
} from "../../../../lib/agentDiagnosticsConsent.ts";
import { AgentAnalyticsErrorCode } from "../../../analytics/reporters/agent-error-fields.ts";
import {
  createAgentNodeResultTracker,
  safeTrackAgentNodeResult,
  type AgentAnalyticsFlow,
  type AgentAnalyticsNode
} from "./agentNodeResultAnalytics.ts";
import { applyDesktopAgentProviderRuntimeProbeFallbacks } from "./desktopAgentProviderRuntimeProbeFallback.ts";
import {
  DesktopAgentProviderAccountLifecycle,
  type AgentProviderStatusPollScheduler
} from "./desktopAgentProviderAccountLifecycle.ts";
import {
  resolveAgentProviderInstallErrorMessage,
  runInstalledProviderAction,
  shouldTrackPendingAction
} from "./desktopAgentProviderInstall.ts";
import { reconcileProviderStatuses } from "./desktopAgentProviderStatusCatalog.ts";
import { latestProviderStatusLogLine } from "./desktopAgentProviderStatusLog.ts";

export interface DesktopAgentProviderStatusServiceDependencies {
  loginStatusPollDurationMs?: number;
  loginStatusPollIntervalMs?: number;
  loginStatusPollScheduler?: AgentProviderStatusPollScheduler;
  tuttidClient: TuttidClient;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  diagnosticsConsentStore?: DiagnosticsConsentStore;
  requestTimeoutMs?: number;
  runtimeApi?: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
}

/** Persists whether the user agreed to send fuller diagnostics via "上报异常". */
export interface DiagnosticsConsentStore {
  get(): boolean;
  set(value: boolean): void;
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
  private readonly notifications: NotificationService;
  private inflightRequest: Promise<AgentProviderStatusListResponse | null> | null =
    null;
  private readonly accountLifecycle: DesktopAgentProviderAccountLifecycle;
  private readonly pendingActionStatusPolls = new Map<
    string,
    AgentProviderStatusPollTimer
  >();
  private requestSequence = 0;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private snapshot: AgentProviderStatusSnapshot = emptySnapshot;
  private readonly transientDowngradeCounts = new Map<string, number>();
  // Last env-detection fingerprint per provider, so `agent.env_detected` fires
  // only when the outcome changes instead of on every status poll.
  private readonly lastEnvSignatures = new Map<
    WorkspaceAgentProvider,
    string
  >();
  private readonly consentStore: DiagnosticsConsentStore;

  constructor(
    dependencies: DesktopAgentProviderStatusServiceDependencies,
    notifications: NotificationService = noopNotifications
  ) {
    this.dependencies = dependencies;
    this.notifications = notifications;
    this.consentStore =
      dependencies.diagnosticsConsentStore ?? createSharedConsentStore();
    this.accountLifecycle = new DesktopAgentProviderAccountLifecycle({
      loginStatusPollDurationMs: dependencies.loginStatusPollDurationMs,
      loginStatusPollIntervalMs: dependencies.loginStatusPollIntervalMs,
      loginStatusPollScheduler: dependencies.loginStatusPollScheduler,
      refresh: async (provider) => this.refresh([provider]),
      reportNodeResult: (input) => this.reportNodeResult(input),
      reporterNow: dependencies.reporterNow,
      reporterService: dependencies.reporterService
    });
  }

  getRevision(): number {
    return this.revision;
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
      return this.snapshotResponse();
    }

    if (this.inflightRequest) {
      await this.inflightRequest;
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
    } = {}
  ): Promise<AgentProviderStatusListResponse | null> {
    if (this.inflightRequest) {
      return this.inflightRequest;
    }

    this.setSnapshot({
      ...this.snapshot,
      error: null,
      isLoading: true
    });

    const requestId = this.requestSequence + 1;
    this.requestSequence = requestId;
    const request = withTimeout(
      this.dependencies.tuttidClient.getAgentProviderStatuses(input),
      this.dependencies.requestTimeoutMs ?? defaultRequestTimeoutMs
    )
      .then(async (response) => {
        let responseProviders = response.providers;
        if (this.requestSequence === requestId) {
          const previousStatuses = this.snapshot.statuses;
          const maybeReconciledStatuses =
            this.reconcileProviderStatusesWithProbe(
              previousStatuses,
              response.providers,
              input.providers
            );
          const reconciledStatuses = Array.isArray(maybeReconciledStatuses)
            ? maybeReconciledStatuses
            : await maybeReconciledStatuses;
          responseProviders = [...reconciledStatuses];
          this.setSnapshot({
            capturedAt: response.capturedAt,
            defaultProvider: response.defaultProvider,
            error: null,
            isLoading: false,
            pendingActions: this.snapshot.pendingActions,
            statuses: reconciledStatuses
          });
          this.logActiveActionSnapshotDiagnostics(reconciledStatuses);
          // Report provider_ready before reportCompletedLoginResults so the
          // pendingLoginResults set is still populated when we classify how a
          // provider became ready (login vs. already-ready vs. external).
          this.accountLifecycle.reportProviderReadyTransitions(
            previousStatuses,
            reconciledStatuses
          );
          this.reportEnvDetectedChanges(reconciledStatuses);
          void this.accountLifecycle.reportCompletedLoginResults(
            response.providers
          );
        }
        await this.reportNodeResult({
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
        if (this.requestSequence === requestId) {
          this.setSnapshot({
            ...this.snapshot,
            error: resolveDesktopErrorMessage(error, getActiveLocale()),
            isLoading: false
          });
        }
        await this.reportNodeResult({
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
        if (this.inflightRequest === request) {
          this.inflightRequest = null;
        }
      });

    this.inflightRequest = request;
    return request;
  }

  async runAction(
    provider: WorkspaceAgentProvider,
    actionId: string,
    context?: AgentProviderStatusActionContext
  ): Promise<void> {
    const isLoginAction = actionId === "login";
    if (isLoginAction) {
      await this.accountLifecycle.reportLoginInitiated(provider);
    }

    let action = this.findAction(provider, actionId);
    if (!action) {
      await this.refresh([provider]);
      action = this.findAction(provider, actionId);
      if (!action) {
        this.notifyMissingAction(actionId);
        if (isLoginAction) {
          await this.accountLifecycle.reportLoginResult(
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
        await this.accountLifecycle.reportLoginResult(
          provider,
          false,
          "unsupported_action",
          "Agent provider login action is unsupported.",
          AgentAnalyticsErrorCode.LoginLaunchFailed
        );
      }
      return;
    }

    const trackPendingAction = shouldTrackPendingAction(action.id);
    if (trackPendingAction) {
      this.addPendingAction(provider, actionId);
    }
    try {
      if (action.id === "install") {
        await runInstalledProviderAction(
          this.dependencies.tuttidClient,
          provider
        );
        await this.refresh([provider]);
        await this.reportNodeResult({
          flow: "provider_setup",
          node: "install_action_requested",
          provider,
          success: true
        });
        return;
      }

      if (!action.command) {
        if (isLoginAction) {
          await this.accountLifecycle.reportLoginResult(
            provider,
            false,
            "command_missing",
            "Agent provider login command is missing.",
            AgentAnalyticsErrorCode.LoginLaunchFailed
          );
        }
        return;
      }

      const terminalLaunchStartedAt = this.accountLifecycle.now();
      const terminal =
        await this.dependencies.terminalCommandRunner.runTerminalCommand(
          action.command,
          context
        );
      if (isLoginAction) {
        await this.reportNodeResult({
          durationMs: this.accountLifecycle.now() - terminalLaunchStartedAt,
          flow: "provider_setup",
          node: "login_terminal_launch",
          provider,
          success: true
        });
        this.accountLifecycle.registerLoginTerminal(provider, terminal);
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
        await this.reportNodeResult({
          error,
          fallbackErrorCode: AgentAnalyticsErrorCode.InstallFailed,
          flow: "provider_setup",
          node: "install_action_requested",
          provider,
          success: false
        });
      }
      if (action.id === "login") {
        this.accountLifecycle.clearLoginTerminal(provider);
        this.notifications.error({
          description: resolveDesktopErrorMessage(error, getActiveLocale()),
          title: translate(
            "workspace.workbenchDesktop.agentProviders.loginFailed"
          )
        });
        await this.accountLifecycle.reportLoginResult(
          provider,
          false,
          "launch_failed",
          error,
          AgentAnalyticsErrorCode.LoginLaunchFailed
        );
        await this.reportNodeResult({
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
    if (this.inflightRequest) {
      await this.inflightRequest;
    }
    await this.requestStatuses({
      providers,
      includeNetwork: options?.includeNetwork
    });
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

  private reconcileProviderStatusesWithProbe(
    previousStatuses: readonly AgentProviderStatus[],
    responseStatuses: readonly AgentProviderStatus[],
    requestedProviders: readonly WorkspaceAgentProvider[] | undefined
  ): readonly AgentProviderStatus[] | Promise<readonly AgentProviderStatus[]> {
    const reconciledStatuses = reconcileProviderStatuses({
      previousStatuses,
      requestedProviders,
      responseStatuses,
      transientDowngradeCounts: this.transientDowngradeCounts
    });
    return applyDesktopAgentProviderRuntimeProbeFallbacks({
      probeProvider: (provider) =>
        this.dependencies.tuttidClient.probeAgentProvider(provider),
      requestedProviders,
      statuses: reconciledStatuses
    });
  }

  private addPendingAction(
    provider: WorkspaceAgentProvider,
    actionId: string
  ): void {
    if (this.isActionPending(provider, actionId)) {
      return;
    }
    this.logRendererDiagnostic("agent_provider_status.pending_action_added", {
      actionId,
      provider
    });
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
    this.logRendererDiagnostic("agent_provider_status.pending_action_removed", {
      actionId,
      provider
    });
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
    if (!this.isActionPending(provider, actionId)) {
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
    unrefPollTimer(timer);
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

  // Always-on, privacy-safe: fire `agent.env_detected` once per provider per
  // distinct detection outcome, so we can see how users' environments resolve
  // without spamming on routine polls.
  private reportEnvDetectedChanges(
    statuses: readonly AgentProviderStatus[]
  ): void {
    for (const status of statuses) {
      const signature = envDetectedSignature(status);
      if (this.lastEnvSignatures.get(status.provider) === signature) {
        continue;
      }
      this.lastEnvSignatures.set(status.provider, signature);
      void this.reportEnvDetected(status);
    }
  }

  private async reportEnvDetected(status: AgentProviderStatus): Promise<void> {
    try {
      await new AgentEnvDetectedReporter(buildEnvDetectedParams(status), {
        now: this.dependencies.reporterNow,
        reporterService: createOptionalReporterService(
          this.dependencies.reporterService
        )
      }).report();
    } catch {
      // Analytics must not block agent provider actions.
    }
  }

  getDiagnosticsConsent(): boolean {
    return this.consentStore.get();
  }

  setDiagnosticsConsent(value: boolean): void {
    this.consentStore.set(value);
  }

  // The consent-gated "report problem" action: sends the fuller diagnostic
  // payload, but only when the user has agreed.
  async reportEnvIssue(provider: WorkspaceAgentProvider): Promise<void> {
    if (!this.consentStore.get()) {
      return;
    }
    const status = this.getStatus(provider);
    if (!status) {
      return;
    }
    try {
      await new AgentEnvIssueReportedReporter(buildEnvIssueParams(status), {
        now: this.dependencies.reporterNow,
        reporterService: createOptionalReporterService(
          this.dependencies.reporterService
        )
      }).report();
    } catch {
      // Analytics must not block agent provider actions.
    }
  }

  private async reportNodeResult(input: {
    agentSessionId?: string | null;
    durationMs?: number | null;
    error?: unknown;
    fallbackErrorCode?: AgentAnalyticsErrorCode;
    flow: AgentAnalyticsFlow;
    node: AgentAnalyticsNode;
    provider?: string | null;
    success: boolean;
  }): Promise<void> {
    await safeTrackAgentNodeResult(
      createAgentNodeResultTracker({
        reporterNow: this.dependencies.reporterNow,
        reporterService: this.dependencies.reporterService
      }),
      input
    );
  }

  private logActiveActionSnapshotDiagnostics(
    statuses: readonly AgentProviderStatus[]
  ): void {
    for (const status of statuses) {
      const activeAction = status.activeAction ?? null;
      const installPending = this.isActionPending(status.provider, "install");
      if (!activeAction && !installPending) {
        continue;
      }
      const log = activeAction?.log ?? [];
      this.logRendererDiagnostic(
        "agent_provider_status.active_action_snapshot",
        {
          activeActionPresent: activeAction !== null,
          availability: status.availability.status,
          installPending,
          latestLogPresent: latestProviderStatusLogLine(log) !== null,
          logLines: log.length,
          phase: activeAction?.phase ?? null,
          provider: status.provider,
          reasonCode: status.availability.reasonCode ?? null,
          registryPresent: Boolean(activeAction?.registry)
        }
      );
    }
  }

  private logRendererDiagnostic(
    event: string,
    details: Record<string, unknown>
  ): void {
    void this.dependencies.runtimeApi
      ?.logRendererDiagnostic({
        details,
        event,
        level: "info",
        source: "agent-provider-status"
      })
      .catch(() => {});
  }
}

function pendingActionKey(
  provider: WorkspaceAgentProvider,
  actionId: string
): string {
  return `${provider}:${actionId}`;
}

function createOptionalReporterService(
  reporterService: Pick<IReporterService, "trackEvents"> | undefined
): Pick<IReporterService, "trackEvents"> {
  return (
    reporterService ?? {
      async trackEvents() {}
    }
  );
}

function createSharedConsentStore(): DiagnosticsConsentStore {
  return {
    get: getAgentDiagnosticsConsent,
    set: setAgentDiagnosticsConsent
  };
}

function unrefPollTimer(timer: AgentProviderStatusPollTimer): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeoutID: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(() => {
      reject(new Error("Agent provider status request timed out."));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutID) {
      clearTimeout(timeoutID);
    }
  });
}
