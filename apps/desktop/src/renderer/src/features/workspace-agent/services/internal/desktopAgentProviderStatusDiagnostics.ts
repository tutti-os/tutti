import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import {
  getAgentDiagnosticsConsent,
  setAgentDiagnosticsConsent
} from "../../../../lib/agentDiagnosticsConsent.ts";
import { AgentEnvDetectedReporter } from "../../../analytics/reporters/agent-env-detected/agentEnvDetectedReporter.ts";
import { AgentEnvIssueReportedReporter } from "../../../analytics/reporters/agent-env-issue-reported/agentEnvIssueReportedReporter.ts";
import { AgentAnalyticsErrorCode } from "../../../analytics/reporters/agent-error-fields.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  buildEnvDetectedParams,
  buildEnvIssueParams,
  envDetectedSignature
} from "./agentEnvTelemetry.ts";
import {
  createAgentNodeResultTracker,
  safeTrackAgentNodeResult,
  type AgentAnalyticsFlow,
  type AgentAnalyticsNode
} from "./agentNodeResultAnalytics.ts";
import { latestProviderStatusLogLine } from "./desktopAgentProviderStatusLog.ts";

export interface DiagnosticsConsentStore {
  get(): boolean;
  set(value: boolean): void;
}

export interface AgentProviderStatusRequestInput {
  providers?: readonly WorkspaceAgentProvider[];
  includeNetwork?: boolean;
}

interface DesktopAgentProviderStatusDiagnosticsDependencies {
  consentStore?: DiagnosticsConsentStore;
  now?: () => number;
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi?: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
}

export class DesktopAgentProviderStatusDiagnostics {
  private readonly consentStore: DiagnosticsConsentStore;
  private readonly dependencies: DesktopAgentProviderStatusDiagnosticsDependencies;
  private readonly lastEnvSignatures = new Map<
    WorkspaceAgentProvider,
    string
  >();

  constructor(dependencies: DesktopAgentProviderStatusDiagnosticsDependencies) {
    this.dependencies = dependencies;
    this.consentStore = dependencies.consentStore ?? createSharedConsentStore();
  }

  logStatusRequestCacheHit(
    input: AgentProviderStatusRequestInput,
    cachedProviderCount: number
  ): void {
    this.logRendererDiagnostic("agent_provider_status.request.cache_hit", {
      ...statusRequestDetails(input),
      cachedProviderCount
    });
  }

  logStatusRequestReused(input: AgentProviderStatusRequestInput): void {
    this.logRendererDiagnostic("agent_provider_status.request.reused", {
      ...statusRequestDetails(input)
    });
  }

  logStatusRequestStarted(input: {
    request: AgentProviderStatusRequestInput;
    requestId: number;
  }): number {
    const startedAt = this.now();
    this.logRendererDiagnostic("agent_provider_status.request.started", {
      ...statusRequestDetails(input.request),
      requestId: input.requestId
    });
    return startedAt;
  }

  logStatusRequestResolved(input: {
    appliedProviderCount: number;
    request: AgentProviderStatusRequestInput;
    requestId: number;
    responseProviderCount: number;
    staleProviderCount: number;
    startedAt: number;
  }): number {
    const durationMs = elapsedMilliseconds(this.now(), input.startedAt);
    this.logRendererDiagnostic("agent_provider_status.request.resolved", {
      ...statusRequestDetails(input.request),
      appliedProviderCount: input.appliedProviderCount,
      durationMs,
      requestId: input.requestId,
      responseProviderCount: input.responseProviderCount,
      staleProviderCount: input.staleProviderCount
    });
    return durationMs;
  }

  logStatusRequestFailed(input: {
    error: unknown;
    request: AgentProviderStatusRequestInput;
    requestId: number;
    startedAt: number;
  }): number {
    const durationMs = elapsedMilliseconds(this.now(), input.startedAt);
    this.logRendererDiagnostic("agent_provider_status.request.failed", {
      ...statusRequestDetails(input.request),
      durationMs,
      errorType:
        input.error instanceof Error ? input.error.name : typeof input.error,
      requestId: input.requestId
    });
    return durationMs;
  }

  reportEnvDetectedChanges(statuses: readonly AgentProviderStatus[]): void {
    for (const status of statuses) {
      const signature = envDetectedSignature(status);
      if (this.lastEnvSignatures.get(status.provider) === signature) {
        continue;
      }
      this.lastEnvSignatures.set(status.provider, signature);
      void this.reportEnvDetected(status);
    }
  }

  getDiagnosticsConsent(): boolean {
    return this.consentStore.get();
  }

  setDiagnosticsConsent(value: boolean): void {
    this.consentStore.set(value);
  }

  async reportEnvIssue(status: AgentProviderStatus | null): Promise<void> {
    if (!this.consentStore.get() || !status) {
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

  async reportNodeResult(input: {
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

  logActiveActionSnapshotDiagnostics(
    statuses: readonly AgentProviderStatus[],
    isInstallPending: (provider: WorkspaceAgentProvider) => boolean
  ): void {
    for (const status of statuses) {
      const activeAction = status.activeAction ?? null;
      const installPending = isInstallPending(status.provider);
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

  logRendererDiagnostic(event: string, details: Record<string, unknown>): void {
    void this.dependencies.runtimeApi
      ?.logRendererDiagnostic({
        details,
        event,
        level: "info",
        source: "agent-provider-status"
      })
      .catch(() => {});
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

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}

function statusRequestDetails(input: AgentProviderStatusRequestInput) {
  const providers = [...new Set(input.providers ?? [])].sort();
  return {
    includeNetwork: input.includeNetwork === true,
    providerCount: providers.length,
    providers,
    requestScope: providers.length > 0 ? "providers" : "all"
  };
}

function elapsedMilliseconds(now: number, startedAt: number): number {
  return Math.max(0, Math.round(now - startedAt));
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
