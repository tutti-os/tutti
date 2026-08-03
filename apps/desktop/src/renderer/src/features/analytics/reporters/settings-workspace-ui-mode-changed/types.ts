import type { DesktopWorkspaceUiMode } from "@shared/preferences";
import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface SettingsWorkspaceUiModeChangedParams extends AnalyticsReporterParams {
  action: "enabled" | "disabled";
  previousMode: DesktopWorkspaceUiMode;
  nextMode: DesktopWorkspaceUiMode;
}
