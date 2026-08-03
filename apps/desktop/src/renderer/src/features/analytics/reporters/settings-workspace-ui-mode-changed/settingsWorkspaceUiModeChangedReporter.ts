import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { SettingsWorkspaceUiModeChangedParams } from "./types.ts";

export class SettingsWorkspaceUiModeChangedReporter extends BaseAnalyticsReporter<SettingsWorkspaceUiModeChangedParams> {
  protected readonly eventName = "settings.workspace_ui_mode_changed";

  constructor(
    params: SettingsWorkspaceUiModeChangedParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
