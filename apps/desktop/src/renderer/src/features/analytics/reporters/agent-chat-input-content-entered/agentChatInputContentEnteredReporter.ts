import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies,
  type AnalyticsReporterParams
} from "../baseReporter.ts";
import { projectAgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";
import type { AgentChatInputContentEnteredParams } from "./types.ts";

export class AgentChatInputContentEnteredReporter extends BaseAnalyticsReporter<AnalyticsReporterParams> {
  protected readonly eventName = "agent.chat_input_content_entered";

  constructor(
    params: AgentChatInputContentEnteredParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(
      {
        ...projectAgentChatEngagementBaseParams(params),
        contentType: params.contentType,
        hadPrefill: params.hadPrefill
      },
      dependencies
    );
  }
}
