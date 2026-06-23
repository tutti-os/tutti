import type {
  AgentProviderActionRunResponse,
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { AgentProviderLoginInitiatedReporter } from "../../../analytics/reporters/agent-provider-login-initiated/agentProviderLoginInitiatedReporter.ts";
import { AgentProviderLoginResultReporter } from "../../../analytics/reporters/agent-provider-login-result/agentProviderLoginResultReporter.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
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

export interface DesktopAgentProviderStatusServiceDependencies {
  loginStatusPollDurationMs?: number;
  loginStatusPollIntervalMs?: number;
  loginStatusPollScheduler?: AgentProviderStatusPollScheduler;
  tuttidClient: TuttidClient;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  requestTimeoutMs?: number;
  terminalCommandRunner: AgentProviderTerminalCommandRunner;
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
  private requestSequence = 0;
  private readonly listeners = new Set<() => void>();
  private readonly pendingLoginResults = new Set<WorkspaceAgentProvider>();
  private revision = 0;
  private snapshot: AgentProviderStatusSnapshot = emptySnapshot;
  private readonly transientDowngradeCounts = new Map<string, number>();

  constructor(
    dependencies: DesktopAgentProviderStatusServiceDependencies,
    notifications: NotificationService = noopNotifications
  ) {
    this.dependencies = dependencies;
    this.notifications = notifications;
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
      .then((response) => {
        if (this.requestSequence === requestId) {
          this.setSnapshot({
            capturedAt: response.capturedAt,
            defaultProvider: response.defaultProvider,
            error: null,
            isLoading: false,
            pendingActions: this.snapshot.pendingActions,
            statuses: this.reconcileProviderStatuses(
              this.snapshot.statuses,
              response.providers,
              input.providers
            )
          });
          void this.reportCompletedLoginResults(response.providers);
        }
        return response;
      })
      .catch((error: unknown) => {
        if (this.requestSequence === requestId) {
          this.setSnapshot({
            ...this.snapshot,
            error: resolveDesktopErrorMessage(error, getActiveLocale()),
            isLoading: false
          });
        }
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
          await this.reportLoginResult(provider, false, "action_unavailable");
        }
        return;
      }
    }
    if (action.kind === "refresh") {
      await this.refresh([provider]);
      if (isLoginAction) {
        await this.reportLoginResult(provider, false, "unsupported_action");
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
        return;
      }

      if (!action.command) {
        if (isLoginAction) {
          await this.reportLoginResult(provider, false, "command_missing");
        }
        return;
      }

      await this.dependencies.terminalCommandRunner.runTerminalCommand(
        action.command,
        context
      );
      if (isLoginAction) {
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
      }
      if (action.id === "login") {
        this.notifications.error({
          description: resolveDesktopErrorMessage(error, getActiveLocale()),
          title: translate(
            "workspace.workbenchDesktop.agentProviders.loginFailed"
          )
        });
        await this.reportLoginResult(provider, false, "launch_failed");
      }
      throw error;
    } finally {
      if (trackPendingAction) {
        this.removePendingAction(provider, actionId);
      }
    }
  }

  async refresh(providers?: WorkspaceAgentProvider[]): Promise<void> {
    if (this.inflightRequest) {
      await this.inflightRequest;
    }
    await this.requestStatuses({ providers });
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
        this.stabilizeProviderStatus(previous, status)
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
    this.setSnapshot({
      ...this.snapshot,
      pendingActions: [...this.snapshot.pendingActions, { actionId, provider }]
    });
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
      this.stopLoginStatusPolling(provider);
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
      this.stopLoginStatusPolling(provider);
      return;
    }

    await this.refresh([provider]);

    const current = this.loginStatusPolls.get(provider);
    if (!current || !this.pendingLoginResults.has(provider)) {
      return;
    }
    if (this.loginStatusPollScheduler.now() >= current.deadlineMs) {
      this.stopLoginStatusPolling(provider);
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
      await this.reportLoginResult(status.provider, true, null);
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
    errorReason: string | null
  ): Promise<void> {
    try {
      await new AgentProviderLoginResultReporter(
        { errorReason, provider, success },
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
    return error.reason;
  }
  const message = resolveDesktopErrorMessage(error, getActiveLocale());
  if (isClaudeUnavailableInRegionInstallError(provider, message)) {
    return translate(
      "workspace.workbenchDesktop.agentProviders.installUnavailableInRegion"
    );
  }
  return message;
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
