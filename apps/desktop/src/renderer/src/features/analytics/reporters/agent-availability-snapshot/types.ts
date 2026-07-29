import type { AnalyticsReporterParams } from "../baseReporter.ts";

export type AgentAvailabilitySnapshotTrigger =
  | "config_change"
  | "conversation_start_failed"
  | "daily_rollover"
  | "env_detected"
  | "resume";

export type AgentUnavailableReason =
  | "cli_not_installed"
  | "none"
  | "not_authenticated"
  | "provider_error";

export interface AgentAvailabilitySnapshotParams extends AnalyticsReporterParams {
  authenticated: boolean;
  cliInstalled: boolean;
  isAvailable: boolean;
  provider: string;
  trigger: AgentAvailabilitySnapshotTrigger;
  unavailableReason: AgentUnavailableReason;
}
