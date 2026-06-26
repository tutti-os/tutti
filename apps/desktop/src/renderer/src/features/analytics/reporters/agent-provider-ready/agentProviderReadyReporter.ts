import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentProviderReadyParams } from "./types.ts";

export class AgentProviderReadyReporter extends BaseAnalyticsReporter<AgentProviderReadyParams> {
  protected readonly eventName = "agent.provider_ready";

  constructor(
    params: AgentProviderReadyParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
