import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentNodeResultParams } from "./types.ts";

export class AgentNodeResultReporter extends BaseAnalyticsReporter<AgentNodeResultParams> {
  protected readonly eventName = "agent.node_result";

  constructor(
    params: AgentNodeResultParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
