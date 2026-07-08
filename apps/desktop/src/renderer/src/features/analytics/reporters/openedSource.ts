import type { AnalyticsReporterParams } from "./baseReporter.ts";

export type AnalyticsOpenTrigger = "automatic" | "manual";

export type AnalyticsOpenSource =
  | "agent_command"
  | "browser"
  | "command"
  | "dock"
  | "file_manager"
  | "issue_manager"
  | "keyboard"
  | "launchpad"
  | "restore"
  | "terminal"
  | "workspace_app";

export interface AnalyticsOpenedSourceParams extends AnalyticsReporterParams {
  source: AnalyticsOpenSource;
  trigger: AnalyticsOpenTrigger;
}

export function createAnalyticsOpenedSourceParams(
  source: AnalyticsOpenSource
): AnalyticsOpenedSourceParams {
  return {
    source,
    trigger: toAnalyticsOpenTrigger(source)
  };
}

function toAnalyticsOpenTrigger(
  source: AnalyticsOpenSource
): AnalyticsOpenTrigger {
  return source === "restore" || source === "agent_command"
    ? "automatic"
    : "manual";
}
