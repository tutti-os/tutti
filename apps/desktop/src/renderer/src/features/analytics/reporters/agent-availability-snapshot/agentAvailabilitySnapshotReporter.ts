import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentAvailabilitySnapshotParams } from "./types.ts";

export class AgentAvailabilitySnapshotReporter extends BaseAnalyticsReporter<AgentAvailabilitySnapshotParams> {
  protected readonly eventName = "agent.availability_snapshot";

  constructor(
    params: AgentAvailabilitySnapshotParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
