import type {
  AgentProviderActionRunResponse,
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import { AgentProviderLoginInitiatedReporter } from "../../../analytics/reporters/agent-provider-login-initiated/agentProviderLoginInitiatedReporter.ts";
import { AgentProviderLoginResultReporter } from "../../../analytics/reporters/agent-provider-login-result/agentProviderLoginResultReporter.ts";
import { AgentProviderReadyReporter } from "../../../analytics/reporters/agent-provider-ready/agentProviderReadyReporter.ts";
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
  AgentProviderTerminalCommandHandle,
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
import {
  AgentAnalyticsErrorCode,
  agentAnalyticsErrorFields,
  agentAnalyticsSuccessFields
} from "../../../analytics/reporters/agent-error-fields.ts";
import {
  createAgentNodeResultTracker,
  safeTrackAgentNodeResult,
  type AgentAnalyticsFlow,
  type AgentAnalyticsNode
} from "./agentNodeResultAnalytics.ts";

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

interface AgentProviderStatusPollScheduler {
  clearTimeout(timer: AgentProviderStatusPollTimer): void;
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number
  ): AgentProviderStatusPollTimer;
}

type AgentProviderStatusPollTimer = number | { unref?: () => void };

const defaultRequestTimeoutMs = 15_000;
const defaultLoginStatusPollDurationMs = 3 * 60 * 1000;
const defaultLoginStatusPollIntervalMs = 5_000;
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
  private readonly loginStatusPolls = new Map<
    WorkspaceAgentProvider,
    { deadlineMs: number; timer: AgentProviderStatusPollTimer | null }
  >();
  private readonly pendingActionStatusPolls = new Map<
    string,
    AgentProviderStatusPollTimer
  >();
  private requestSequence = 0;
  private readonly listeners = new Set<() => void>();
  private readonly pendingLoginResults = new Set<WorkspaceAgentProvider>();
  // The login terminal we opened per provider, so we can auto-close it once login
  // succeeds. Kept open on failure/timeout so the user can read the error.
  private readonly pendingLoginTerminals = new Map<
    WorkspaceAgentProvider,
    AgentProviderTerminalCommandHandle
  >();
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
        if (this.requestSequence === requestId) {
          const previousStatuses = this.snapshot.statuses;
          const reconciledStatuses = this.reconcileProviderStatuses(
            previousStatuses,
            response.providers,
            input.providers
          );
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
          this.reportProviderReadyTransitions(
            previousStatuses,
            reconciledStatuses
          );
          this.reportEnvDetectedChanges(reconciledStatuses);
          void this.reportCompletedLoginResults(response.providers);
        }
        await this.reportNodeResult({
          flow: "provider_setup",
          node: "provider_status_request",
          provider: input.providers?.[0] ?? response.defaultProvider ?? null,
          success: true
        });
        return response;
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
      await this.reportLoginInitiated(provider);
    }

    let action = this.findAction(provider, actionId);
    if (!action) {
      await this.refresh([provider]);
      action = this.findAction(provider, actionId);
      if (!action) {
        this.notifyMissingAction(actionId);
        if (isLoginAction) {
          await this.reportLoginResult(
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
        await this.reportLoginResult(
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
          await this.reportLoginResult(
            provider,
            false,
            "command_missing",
            "Agent provider login command is missing.",
            AgentAnalyticsErrorCode.LoginLaunchFailed
          );
        }
        return;
      }

      const terminalLaunchStartedAt = this.loginStatusPollScheduler.now();
      const terminal =
        await this.dependencies.terminalCommandRunner.runTerminalCommand(
          action.command,
          context
        );
      if (isLoginAction) {
        await this.reportNodeResult({
          durationMs:
            this.loginStatusPollScheduler.now() - terminalLaunchStartedAt,
          flow: "provider_setup",
          node: "login_terminal_launch",
          provider,
          success: true
        });
        if (terminal) {
          this.pendingLoginTerminals.set(provider, terminal);
        }
        this.pendingLoginResults.add(provider);
        this.startLoginStatusPolling(provider);
      }
      void this.refresh([provider]);
    } catch (error) {
      if (action.id === "install") {
        this.notifications.error({
          description: resolveAgentProviderInstallErrorMessage(error, provider),
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
        this.pendingLoginTerminals.delete(provider);
        this.notifications.error({
          description: resolveDesktopErrorMessage(error, getActiveLocale()),
          title: translate(
            "workspace.workbenchDesktop.agentProviders.loginFailed"
          )
        });
        await this.reportLoginResult(
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
    if (!this.snapshot.capturedAt) {
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
    return {
      capturedAt: this.snapshot.capturedAt ?? "",
      defaultProvider: this.snapshot.defaultProvider ?? "codex",
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

  private reconcileProviderStatuses(
    previousStatuses: readonly AgentProviderStatus[],
    responseStatuses: readonly AgentProviderStatus[],
    requestedProviders: readonly WorkspaceAgentProvider[] | undefined
  ): readonly AgentProviderStatus[] {
    const previousByProvider = new Map(
      previousStatuses.map((status) => [status.provider, status])
    );
    const nextByProvider = new Map<string, AgentProviderStatus>();
    for (const status of responseStatuses) {
      const previous = previousByProvider.get(status.provider);
      nextByProvider.set(
        status.provider,
        this.preserveNetwork(
          previous,
          this.stabilizeProviderStatus(previous, status)
        )
      );
    }

    if (!requestedProviders || requestedProviders.length === 0) {
      return responseStatuses.map(
        (status) => nextByProvider.get(status.provider) ?? status
      );
    }

    const merged = previousStatuses.map(
      (status) => nextByProvider.get(status.provider) ?? status
    );
    const existingProviders = new Set(merged.map((status) => status.provider));
    for (const status of responseStatuses) {
      if (!existingProviders.has(status.provider)) {
        merged.push(nextByProvider.get(status.provider) ?? status);
      }
    }
    return merged;
  }

  /**
   * Network reachability is now fetched on-demand (only the wizard requests it),
   * so a local-only poll (dock / visibility / install / login) returns a status
   * with no `network`. Carry the last-known network forward so those polls don't
   * wipe the diagnostic the wizard fetched; a later with-network response replaces
   * it.
   */
  private preserveNetwork(
    previous: AgentProviderStatus | undefined,
    next: AgentProviderStatus
  ): AgentProviderStatus {
    if (next.network || !previous?.network) {
      return next;
    }
    return { ...next, network: previous.network };
  }

  private stabilizeProviderStatus(
    previous: AgentProviderStatus | undefined,
    next: AgentProviderStatus
  ): AgentProviderStatus {
    if (!previous || !isTransientProviderStatusDowngrade(previous, next)) {
      this.transientDowngradeCounts.delete(next.provider);
      return next;
    }

    const count = this.transientDowngradeCounts.get(next.provider) ?? 0;
    this.transientDowngradeCounts.set(next.provider, count + 1);
    return count === 0 ? previous : next;
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

  private startLoginStatusPolling(provider: WorkspaceAgentProvider): void {
    const deadlineMs =
      this.loginStatusPollScheduler.now() + this.loginStatusPollDurationMs();
    const existing = this.loginStatusPolls.get(provider);
    if (existing) {
      existing.deadlineMs = deadlineMs;
      return;
    }

    const state = {
      deadlineMs,
      timer: null
    };
    this.loginStatusPolls.set(provider, state);
    this.scheduleLoginStatusPoll(provider, state);
  }

  private scheduleLoginStatusPoll(
    provider: WorkspaceAgentProvider,
    state: { deadlineMs: number; timer: AgentProviderStatusPollTimer | null }
  ): void {
    if (state.timer !== null) {
      return;
    }
    if (this.loginStatusPollScheduler.now() >= state.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }

    state.timer = this.loginStatusPollScheduler.setTimeout(() => {
      state.timer = null;
      void this.runLoginStatusPoll(provider);
    }, this.loginStatusPollIntervalMs());
    unrefPollTimer(state.timer);
  }

  private async runLoginStatusPoll(
    provider: WorkspaceAgentProvider
  ): Promise<void> {
    const state = this.loginStatusPolls.get(provider);
    if (!state || this.loginStatusPollScheduler.now() >= state.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }

    const pollStartedAt = this.loginStatusPollScheduler.now();
    await this.refresh([provider]);
    await this.reportNodeResult({
      durationMs: this.loginStatusPollScheduler.now() - pollStartedAt,
      flow: "provider_setup",
      node: "login_auth_poll",
      provider,
      success: true
    });

    const current = this.loginStatusPolls.get(provider);
    if (!current || !this.pendingLoginResults.has(provider)) {
      return;
    }
    if (this.loginStatusPollScheduler.now() >= current.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }
    this.scheduleLoginStatusPoll(provider, current);
  }

  private stopLoginStatusPolling(provider: WorkspaceAgentProvider): void {
    const state = this.loginStatusPolls.get(provider);
    if (!state) {
      return;
    }
    if (state.timer !== null) {
      this.loginStatusPollScheduler.clearTimeout(state.timer);
    }
    this.loginStatusPolls.delete(provider);
  }

  private loginStatusPollDurationMs(): number {
    return Math.max(
      0,
      this.dependencies.loginStatusPollDurationMs ??
        defaultLoginStatusPollDurationMs
    );
  }

  private loginStatusPollIntervalMs(): number {
    return Math.max(
      0,
      this.dependencies.loginStatusPollIntervalMs ??
        defaultLoginStatusPollIntervalMs
    );
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

  private async reportCompletedLoginResults(
    statuses: readonly AgentProviderStatus[]
  ): Promise<void> {
    for (const status of statuses) {
      if (
        !this.pendingLoginResults.has(status.provider) ||
        status.availability.status !== "ready"
      ) {
        continue;
      }
      this.pendingLoginResults.delete(status.provider);
      this.stopLoginStatusPolling(status.provider);
      // Login succeeded — dismiss the terminal we opened for it.
      this.closePendingLoginTerminal(status.provider);
      await this.reportNodeResult({
        flow: "provider_setup",
        node: "login_ready_detected",
        provider: status.provider,
        success: true
      });
      await this.reportLoginResult(status.provider, true, null);
    }
  }

  private reportLoginTimeout(provider: WorkspaceAgentProvider): void {
    const hadPendingResult = this.pendingLoginResults.delete(provider);
    this.pendingLoginTerminals.delete(provider);
    this.stopLoginStatusPolling(provider);
    if (!hadPendingResult) {
      return;
    }
    void this.reportLoginResult(
      provider,
      false,
      "timeout",
      "Agent provider login timed out.",
      AgentAnalyticsErrorCode.LoginTimeout
    );
  }

  private closePendingLoginTerminal(provider: WorkspaceAgentProvider): void {
    const terminal = this.pendingLoginTerminals.get(provider);
    if (!terminal) {
      return;
    }
    this.pendingLoginTerminals.delete(provider);
    terminal.close();
  }

  private reportProviderReadyTransitions(
    previousStatuses: readonly AgentProviderStatus[],
    nextStatuses: readonly AgentProviderStatus[]
  ): void {
    const previousByProvider = new Map(
      previousStatuses.map((status) => [status.provider, status])
    );
    for (const status of nextStatuses) {
      if (status.availability.status !== "ready") {
        continue;
      }
      const previous = previousByProvider.get(status.provider);
      // Only a transition into "ready" is an activation signal. A provider that
      // was already ready in the prior snapshot re-reports nothing, so the event
      // naturally de-dupes within a session without extra bookkeeping.
      if (previous?.availability.status === "ready") {
        continue;
      }
      const becameReadyVia = this.pendingLoginResults.has(status.provider)
        ? "login"
        : previous
          ? "external"
          : "already_ready";
      void this.reportProviderReady(
        status.provider,
        becameReadyVia,
        previous?.availability.status ?? "absent"
      );
    }
  }

  private async reportProviderReady(
    provider: WorkspaceAgentProvider,
    becameReadyVia: string,
    previousStatus: string
  ): Promise<void> {
    try {
      await new AgentProviderReadyReporter(
        { becameReadyVia, previousStatus, provider },
        {
          now: this.dependencies.reporterNow,
          reporterService: createOptionalReporterService(
            this.dependencies.reporterService
          )
        }
      ).report();
    } catch {
      // Analytics must not block agent provider actions.
    }
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

  private async reportLoginInitiated(
    provider: WorkspaceAgentProvider
  ): Promise<void> {
    try {
      await new AgentProviderLoginInitiatedReporter(
        { provider },
        {
          now: this.dependencies.reporterNow,
          reporterService: createOptionalReporterService(
            this.dependencies.reporterService
          )
        }
      ).report();
    } catch {
      // Analytics must not block agent provider actions.
    }
  }

  private async reportLoginResult(
    provider: WorkspaceAgentProvider,
    success: boolean,
    errorReason: string | null,
    error?: unknown,
    fallbackErrorCode: AgentAnalyticsErrorCode = AgentAnalyticsErrorCode.LoginLaunchFailed
  ): Promise<void> {
    const errorFields = success
      ? agentAnalyticsSuccessFields
      : agentAnalyticsErrorFields(error ?? errorReason, fallbackErrorCode);
    try {
      await new AgentProviderLoginResultReporter(
        { ...errorFields, errorReason, provider, success },
        {
          now: this.dependencies.reporterNow,
          reporterService: createOptionalReporterService(
            this.dependencies.reporterService
          )
        }
      ).report();
    } catch {
      // Analytics must not block agent provider actions.
    }
    await this.reportNodeResult({
      error: success ? undefined : (error ?? errorReason),
      fallbackErrorCode,
      flow: "provider_setup",
      node: "login_action_requested",
      provider,
      success
    });
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

function latestProviderStatusLogLine(log: readonly string[]): string | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const line = log[index]?.trim();
    if (line) {
      return line;
    }
  }
  return null;
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
  // Backed by the shared device-local store so the Settings → General toggle and
  // the wizard's prompt always agree on the value.
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

class AgentProviderInstallActionFailedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "AgentProviderInstallActionFailedError";
  }
}

async function runInstalledProviderAction(
  tuttidClient: TuttidClient,
  provider: WorkspaceAgentProvider
): Promise<void> {
  const result = await tuttidClient.runAgentProviderAction(provider, "install");
  if (result.status !== "failed") {
    return;
  }
  throw new AgentProviderInstallActionFailedError(
    resolveAgentProviderActionFailureReason(result)
  );
}

function resolveAgentProviderActionFailureReason(
  result: AgentProviderActionRunResponse
): string {
  return (
    result.message?.trim() ||
    result.reasonCode?.trim() ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    result.probe?.message?.trim() ||
    result.probe?.reasonCode?.trim() ||
    "Agent provider install action failed."
  );
}

function resolveAgentProviderInstallErrorMessage(
  error: unknown,
  provider: WorkspaceAgentProvider
): string {
  if (error instanceof AgentProviderInstallActionFailedError) {
    if (isClaudeUnavailableInRegionInstallError(provider, error.reason)) {
      return translate(
        "workspace.workbenchDesktop.agentProviders.installUnavailableInRegion"
      );
    }
    return summarizeAgentProviderInstallFailureReason(error.reason);
  }
  const message = resolveDesktopErrorMessage(error, getActiveLocale());
  if (isClaudeUnavailableInRegionInstallError(provider, message)) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installUnavailableInRegion"
    );
  }
  if (isTechnicalInstallFailureMessage(message)) {
    return summarizeAgentProviderInstallFailureReason(message);
  }
  return message;
}

function summarizeAgentProviderInstallFailureReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedDescription"
    );
  }

  const normalized = trimmed.toLowerCase();
  if (
    normalized.includes("timed out") ||
    normalized.includes("install_timed_out")
  ) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedTimedOut"
    );
  }

  if (
    normalized.includes("enoent") ||
    normalized.includes("error: spawn") ||
    normalized.includes("spawn ") ||
    normalized.includes("post_install_probe_failed") ||
    isTechnicalInstallFailureMessage(trimmed)
  ) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installFailedMissingRuntime"
    );
  }

  if (trimmed.length <= 120 && !trimmed.includes("\n")) {
    return trimmed;
  }

  return translate(
    "workspace.workbenchDesktop.agentProviders.installFailedDescription"
  );
}

function isTechnicalInstallFailureMessage(message: string): boolean {
  return (
    message.includes("\n") ||
    message.includes(" at ") ||
    message.includes("errno:") ||
    message.includes("syscall:") ||
    message.includes("spawnargs:") ||
    message.includes("ChildProcess")
  );
}

function isClaudeUnavailableInRegionInstallError(
  provider: WorkspaceAgentProvider,
  message: string
): boolean {
  if (provider !== "claude-code") {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("app-unavailable-in-region") ||
    normalized.includes("app unavailable in region") ||
    normalized.includes("claude isn't available here") ||
    normalized.includes("claude isn&#x27;t available here") ||
    normalized.includes("claude isn&apos;t available here")
  );
}

function isTransientProviderStatusDowngrade(
  previous: AgentProviderStatus,
  next: AgentProviderStatus
): boolean {
  if (previous.provider !== next.provider) {
    return false;
  }
  const reasonCode = next.availability.reasonCode ?? "";
  return (
    previous.availability.status === "ready" &&
    next.cli.installed &&
    next.adapter.installed &&
    next.availability.status === "auth_required" &&
    (reasonCode === "auth_required" || reasonCode === "auth_unknown")
  );
}

function shouldTrackPendingAction(actionId: string): boolean {
  return actionId === "install";
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
