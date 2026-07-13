import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentChatInputContentEnteredParams } from "./types.ts";

export class AgentChatInputContentEnteredReporter extends BaseAnalyticsReporter<AgentChatInputContentEnteredParams> {
  protected readonly eventName = "agent.chat_input_content_entered";

  constructor(
    params: AgentChatInputContentEnteredParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
