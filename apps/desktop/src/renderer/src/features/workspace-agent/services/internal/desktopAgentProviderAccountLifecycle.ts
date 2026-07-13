import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { AgentProviderLoginInitiatedReporter } from "../../../analytics/reporters/agent-provider-login-initiated/agentProviderLoginInitiatedReporter.ts";
import { AgentProviderLoginResultReporter } from "../../../analytics/reporters/agent-provider-login-result/agentProviderLoginResultReporter.ts";
import { AgentProviderReadyReporter } from "../../../analytics/reporters/agent-provider-ready/agentProviderReadyReporter.ts";
import {
  AgentAnalyticsErrorCode,
  agentAnalyticsErrorFields,
  agentAnalyticsSuccessFields
} from "../../../analytics/reporters/agent-error-fields.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { AgentProviderTerminalCommandHandle } from "../agentProviderStatusService.interface";
import type {
  AgentAnalyticsFlow,
  AgentAnalyticsNode
} from "./agentNodeResultAnalytics.ts";

export interface AgentProviderStatusPollScheduler {
  clearTimeout(timer: AgentProviderStatusPollTimer): void;
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number
  ): AgentProviderStatusPollTimer;
}

type AgentProviderStatusPollTimer = number | { unref?: () => void };

export interface AgentProviderAccountLifecycleDependencies {
  loginStatusPollDurationMs?: number;
  loginStatusPollIntervalMs?: number;
  loginStatusPollScheduler?: AgentProviderStatusPollScheduler;
  refresh(provider: WorkspaceAgentProvider): Promise<void>;
  reportNodeResult(input: {
    agentSessionId?: string | null;
    durationMs?: number | null;
    error?: unknown;
    fallbackErrorCode?: AgentAnalyticsErrorCode;
    flow: AgentAnalyticsFlow;
    node: AgentAnalyticsNode;
    provider?: string | null;
    success: boolean;
  }): Promise<void>;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}

const defaultLoginStatusPollDurationMs = 3 * 60 * 1000;
const defaultLoginStatusPollIntervalMs = 5_000;

const defaultLoginStatusPollScheduler: AgentProviderStatusPollScheduler = {
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs)
};

export class DesktopAgentProviderAccountLifecycle {
  private readonly dependencies: AgentProviderAccountLifecycleDependencies;
  private readonly loginStatusPolls = new Map<
    WorkspaceAgentProvider,
    { deadlineMs: number; timer: AgentProviderStatusPollTimer | null }
  >();
  private readonly pendingLoginResults = new Set<WorkspaceAgentProvider>();
  private readonly pendingLoginTerminals = new Map<
    WorkspaceAgentProvider,
    AgentProviderTerminalCommandHandle
  >();

  constructor(dependencies: AgentProviderAccountLifecycleDependencies) {
    this.dependencies = dependencies;
  }

  now(): number {
    return this.scheduler.now();
  }

  registerLoginTerminal(
    provider: WorkspaceAgentProvider,
    terminal: AgentProviderTerminalCommandHandle | void
  ): void {
    if (terminal) {
      this.pendingLoginTerminals.set(provider, terminal);
    }
    this.pendingLoginResults.add(provider);
    this.startStatusPolling(provider);
  }

  clearLoginTerminal(provider: WorkspaceAgentProvider): void {
    this.pendingLoginTerminals.delete(provider);
  }

  async reportCompletedLoginResults(
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
      this.stopStatusPolling(status.provider);
      this.closePendingTerminal(status.provider);
      await this.dependencies.reportNodeResult({
        flow: "provider_setup",
        node: "login_ready_detected",
        provider: status.provider,
        success: true
      });
      await this.reportLoginResult(status.provider, true, null);
    }
  }

  reportProviderReadyTransitions(
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

  async reportLoginInitiated(provider: WorkspaceAgentProvider): Promise<void> {
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

  async reportLoginResult(
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
    await this.dependencies.reportNodeResult({
      error: success ? undefined : (error ?? errorReason),
      fallbackErrorCode,
      flow: "provider_setup",
      node: "login_action_requested",
      provider,
      success
    });
  }

  private startStatusPolling(provider: WorkspaceAgentProvider): void {
    const deadlineMs = this.scheduler.now() + this.pollDurationMs();
    const existing = this.loginStatusPolls.get(provider);
    if (existing) {
      existing.deadlineMs = deadlineMs;
      return;
    }
    const state = { deadlineMs, timer: null };
    this.loginStatusPolls.set(provider, state);
    this.scheduleStatusPoll(provider, state);
  }

  private scheduleStatusPoll(
    provider: WorkspaceAgentProvider,
    state: { deadlineMs: number; timer: AgentProviderStatusPollTimer | null }
  ): void {
    if (state.timer !== null) {
      return;
    }
    if (this.scheduler.now() >= state.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }
    state.timer = this.scheduler.setTimeout(() => {
      state.timer = null;
      void this.runStatusPoll(provider);
    }, this.pollIntervalMs());
    unrefPollTimer(state.timer);
  }

  private async runStatusPoll(provider: WorkspaceAgentProvider): Promise<void> {
    const state = this.loginStatusPolls.get(provider);
    if (!state || this.scheduler.now() >= state.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }
    const pollStartedAt = this.scheduler.now();
    await this.dependencies.refresh(provider);
    await this.dependencies.reportNodeResult({
      durationMs: this.scheduler.now() - pollStartedAt,
      flow: "provider_setup",
      node: "login_auth_poll",
      provider,
      success: true
    });
    const current = this.loginStatusPolls.get(provider);
    if (!current || !this.pendingLoginResults.has(provider)) {
      return;
    }
    if (this.scheduler.now() >= current.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }
    this.scheduleStatusPoll(provider, current);
  }

  private reportLoginTimeout(provider: WorkspaceAgentProvider): void {
    const hadPendingResult = this.pendingLoginResults.delete(provider);
    this.pendingLoginTerminals.delete(provider);
    this.stopStatusPolling(provider);
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

  private stopStatusPolling(provider: WorkspaceAgentProvider): void {
    const state = this.loginStatusPolls.get(provider);
    if (!state) {
      return;
    }
    if (state.timer !== null) {
      this.scheduler.clearTimeout(state.timer);
    }
    this.loginStatusPolls.delete(provider);
  }

  private closePendingTerminal(provider: WorkspaceAgentProvider): void {
    const terminal = this.pendingLoginTerminals.get(provider);
    if (!terminal) {
      return;
    }
    this.pendingLoginTerminals.delete(provider);
    terminal.close();
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

  private pollDurationMs(): number {
    return Math.max(
      0,
      this.dependencies.loginStatusPollDurationMs ??
        defaultLoginStatusPollDurationMs
    );
  }

  private pollIntervalMs(): number {
    return Math.max(
      0,
      this.dependencies.loginStatusPollIntervalMs ??
        defaultLoginStatusPollIntervalMs
    );
  }

  private get scheduler(): AgentProviderStatusPollScheduler {
    return (
      this.dependencies.loginStatusPollScheduler ??
      defaultLoginStatusPollScheduler
    );
  }
}

function createOptionalReporterService(
  reporterService: Pick<IReporterService, "trackEvents"> | undefined
): Pick<IReporterService, "trackEvents"> {
  return (
    reporterService ?? {
      trackEvents: async () => {}
    }
  );
}

function unrefPollTimer(timer: AgentProviderStatusPollTimer): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}
