import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import { AgentAvailabilitySnapshotReporter } from "../../../analytics/reporters/agent-availability-snapshot/agentAvailabilitySnapshotReporter.ts";
import type {
  AgentAvailabilitySnapshotParams,
  AgentAvailabilitySnapshotTrigger,
  AgentUnavailableReason
} from "../../../analytics/reporters/agent-availability-snapshot/types.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";

export interface AgentAvailabilitySnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface AgentAvailabilitySnapshotState {
  date: string;
  signature: string;
}

interface AgentAvailabilitySnapshotTelemetryDependencies {
  now?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  storage?: AgentAvailabilitySnapshotStorage | null;
}

const storageKeyPrefix = "tutti.analytics.agent.availability_snapshot.v1";

export class AgentAvailabilitySnapshotTelemetry {
  private readonly dependencies: AgentAvailabilitySnapshotTelemetryDependencies;
  private readonly fallbackState = new Map<
    string,
    AgentAvailabilitySnapshotState
  >();
  private readonly storage: AgentAvailabilitySnapshotStorage | null;

  constructor(
    dependencies: AgentAvailabilitySnapshotTelemetryDependencies = {}
  ) {
    this.dependencies = dependencies;
    this.storage =
      dependencies.storage === undefined
        ? resolveLocalStorage()
        : dependencies.storage;
  }

  reportStatuses(
    statuses: readonly AgentProviderStatus[],
    occurredAt: number = this.now()
  ): void {
    const now = occurredAt;
    const date = localDateKey(now);
    for (const status of statuses) {
      const params = buildAvailabilitySnapshotParams(status, "env_detected");
      const signature = snapshotSignature(params);
      const previous = this.readState(status.provider);
      const trigger = snapshotTrigger({
        currentDate: date,
        currentSignature: signature,
        previous
      });
      this.reportStatus(status, trigger, now);
    }
  }

  reportStatus(
    status: AgentProviderStatus,
    trigger: AgentAvailabilitySnapshotTrigger,
    occurredAt: number = this.now()
  ): void {
    const params = buildAvailabilitySnapshotParams(status, trigger);
    // State classifies the next snapshot; it does not suppress a pageview or
    // failure-diagnostic opportunity when the provider state is unchanged.
    this.writeState(status.provider, {
      date: localDateKey(occurredAt),
      signature: snapshotSignature(params)
    });
    void this.report(params, occurredAt);
  }

  private async report(
    params: AgentAvailabilitySnapshotParams,
    now: number
  ): Promise<void> {
    try {
      await new AgentAvailabilitySnapshotReporter(params, {
        now: () => now,
        reporterService: createOptionalReporterService(
          this.dependencies.reporterService
        )
      }).report();
    } catch {
      // Analytics must not block agent provider status refreshes.
    }
  }

  private readState(provider: string): AgentAvailabilitySnapshotState | null {
    const key = storageKey(provider);
    if (this.storage) {
      try {
        const parsed = parseState(this.storage.getItem(key));
        if (parsed) {
          return parsed;
        }
      } catch {
        // Fall back to in-memory dedupe when localStorage is unavailable.
      }
    }
    return this.fallbackState.get(key) ?? null;
  }

  private writeState(
    provider: string,
    state: AgentAvailabilitySnapshotState
  ): void {
    const key = storageKey(provider);
    this.fallbackState.set(key, state);
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(key, JSON.stringify(state));
    } catch {
      // In-memory state still prevents duplicate sends for this renderer.
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}

export function buildAvailabilitySnapshotParams(
  status: AgentProviderStatus,
  trigger: AgentAvailabilitySnapshotTrigger
): AgentAvailabilitySnapshotParams {
  const cliInstalled = status.cli.installed;
  const authenticated = status.auth.status === "authenticated";
  const isAvailable =
    cliInstalled && authenticated && status.availability.status === "ready";
  return {
    authenticated,
    cliInstalled,
    isAvailable,
    provider: analyticsProvider(status.provider),
    trigger,
    unavailableReason: unavailableReason({
      authenticated,
      cliInstalled,
      isAvailable
    })
  };
}

function unavailableReason(input: {
  authenticated: boolean;
  cliInstalled: boolean;
  isAvailable: boolean;
}): AgentUnavailableReason {
  if (input.isAvailable) {
    return "none";
  }
  if (!input.cliInstalled) {
    return "cli_not_installed";
  }
  if (!input.authenticated) {
    return "not_authenticated";
  }
  return "provider_error";
}

function snapshotTrigger(input: {
  currentDate: string;
  currentSignature: string;
  previous: AgentAvailabilitySnapshotState | null;
}): AgentAvailabilitySnapshotTrigger {
  if (!input.previous) {
    return "env_detected";
  }
  if (input.previous.date !== input.currentDate) {
    return "daily_rollover";
  }
  if (input.previous.signature !== input.currentSignature) {
    return "config_change";
  }
  return "env_detected";
}

function snapshotSignature(params: AgentAvailabilitySnapshotParams): string {
  return JSON.stringify([
    params.isAvailable,
    params.unavailableReason,
    params.cliInstalled,
    params.authenticated
  ]);
}

function analyticsProvider(provider: string): string {
  return provider.replaceAll("-", "_");
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function storageKey(provider: string): string {
  return `${storageKeyPrefix}.${analyticsProvider(provider)}`;
}

function parseState(raw: string | null): AgentAvailabilitySnapshotState | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<AgentAvailabilitySnapshotState>;
    if (typeof value.date !== "string" || typeof value.signature !== "string") {
      return null;
    }
    return { date: value.date, signature: value.signature };
  } catch {
    return null;
  }
}

function resolveLocalStorage(): AgentAvailabilitySnapshotStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
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
