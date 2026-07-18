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
import type { AgentProviderActionOrigin } from "../agentProviderStatusService.interface";
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

export interface AgentProviderLoginLifecycleDependencies {
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

interface ActiveLoginAttempt {
  deadlineMs: number;
  generation: number;
  phase: "launching" | "awaiting-auth";
  terminal: AgentProviderTerminalCommandHandle | null;
  timer: AgentProviderStatusPollTimer | null;
}

export class DesktopAgentProviderLoginLifecycle {
  private readonly dependencies: AgentProviderLoginLifecycleDependencies;
  private readonly activeAttempts = new Map<
    WorkspaceAgentProvider,
    ActiveLoginAttempt
  >();
  private nextGeneration = 0;

  constructor(dependencies: AgentProviderLoginLifecycleDependencies) {
    this.dependencies = dependencies;
  }

  now(): number {
    return this.scheduler.now();
  }

  beginLogin(
    provider: WorkspaceAgentProvider,
    origin: AgentProviderActionOrigin
  ):
    | { kind: "reuse" }
    | { generation: number; kind: "start"; replaced: boolean } {
    const existing = this.activeAttempts.get(provider);
    if (
      existing &&
      (origin === "automatic" || existing.phase === "launching")
    ) {
      return { kind: "reuse" };
    }
    const replaced = existing !== undefined;
    if (existing) {
      this.finishAttempt(provider, existing, true);
    }
    const generation = ++this.nextGeneration;
    this.activeAttempts.set(provider, {
      deadlineMs: this.scheduler.now() + this.pollDurationMs(),
      generation,
      phase: "launching",
      terminal: null,
      timer: null
    });
    return { generation, kind: "start", replaced };
  }

  registerLoginTerminal(
    provider: WorkspaceAgentProvider,
    generation: number,
    terminal: AgentProviderTerminalCommandHandle | void
  ): boolean {
    const attempt = this.activeAttempts.get(provider);
    if (!attempt || attempt.generation !== generation) {
      terminal?.close();
      return false;
    }
    attempt.phase = "awaiting-auth";
    attempt.terminal = terminal ?? null;
    this.scheduleStatusPoll(provider, attempt);
    return true;
  }

  failLoginLaunch(provider: WorkspaceAgentProvider, generation: number): void {
    const attempt = this.activeAttempts.get(provider);
    if (!attempt || attempt.generation !== generation) {
      return;
    }
    this.finishAttempt(provider, attempt, true);
  }

  async reportCompletedLoginResults(
    statuses: readonly AgentProviderStatus[]
  ): Promise<void> {
    for (const status of statuses) {
      if (
        !this.activeAttempts.has(status.provider) ||
        status.availability.status !== "ready"
      ) {
        continue;
      }
      const attempt = this.activeAttempts.get(status.provider);
      if (!attempt) {
        continue;
      }
      this.finishAttempt(status.provider, attempt, true);
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
      const becameReadyVia = this.activeAttempts.has(status.provider)
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

  private scheduleStatusPoll(
    provider: WorkspaceAgentProvider,
    state: ActiveLoginAttempt
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
    const state = this.activeAttempts.get(provider);
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
    const current = this.activeAttempts.get(provider);
    if (!current || current.generation !== state.generation) {
      return;
    }
    if (this.scheduler.now() >= current.deadlineMs) {
      this.reportLoginTimeout(provider);
      return;
    }
    this.scheduleStatusPoll(provider, current);
  }

  private reportLoginTimeout(provider: WorkspaceAgentProvider): void {
    const attempt = this.activeAttempts.get(provider);
    if (!attempt) {
      return;
    }
    this.finishAttempt(provider, attempt, true);
    void this.reportLoginResult(
      provider,
      false,
      "timeout",
      "Agent provider login timed out.",
      AgentAnalyticsErrorCode.LoginTimeout
    );
  }

  dispose(): void {
    for (const [provider, attempt] of this.activeAttempts) {
      this.finishAttempt(provider, attempt, true);
    }
  }

  private finishAttempt(
    provider: WorkspaceAgentProvider,
    attempt: ActiveLoginAttempt,
    closeTerminal: boolean
  ): void {
    if (this.activeAttempts.get(provider) !== attempt) {
      return;
    }
    this.activeAttempts.delete(provider);
    if (attempt.timer !== null) {
      this.scheduler.clearTimeout(attempt.timer);
      attempt.timer = null;
    }
    if (closeTerminal) {
      attempt.terminal?.close();
    }
    attempt.terminal = null;
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
