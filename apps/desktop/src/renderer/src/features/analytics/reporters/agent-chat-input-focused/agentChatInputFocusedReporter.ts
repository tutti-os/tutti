import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentChatInputFocusedParams } from "./types.ts";

export class AgentChatInputFocusedReporter extends BaseAnalyticsReporter<AgentChatInputFocusedParams> {
  protected readonly eventName = "agent.chat_input_focused";

  constructor(
    params: AgentChatInputFocusedParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
