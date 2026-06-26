import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentChatReadyParams } from "./types.ts";

export class AgentChatReadyReporter extends BaseAnalyticsReporter<AgentChatReadyParams> {
  protected readonly eventName = "agent.chat_ready";

  constructor(
    params: AgentChatReadyParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
