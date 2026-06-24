import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AppCenterAppInstalledParams extends AnalyticsReporterParams {
  readonly appId: string;
  readonly appSource: "builtin" | "generated" | "imported" | "local-dev";
}
