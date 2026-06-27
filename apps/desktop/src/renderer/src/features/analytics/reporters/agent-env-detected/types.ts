import type { AnalyticsReporterParams } from "../baseReporter.ts";

export interface AgentEnvDetectedParams extends AnalyticsReporterParams {
  provider: string;
  availabilityStatus: string;
  reasonCode: string;
  cliInstalled: boolean;
  cliVersion: string;
  adapterInstalled: boolean;
  adapterVersion: string;
  adapterRequiredVersion: string;
  authenticated: boolean;
  networkRegistryReachable: boolean | null;
  networkApiStatus: string;
  networkProxyConfigured: boolean | null;
  networkProxyReachable: boolean | null;
}
