import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies,
  type AnalyticsReporterParams
} from "../baseReporter.ts";
import { projectAgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";
import type { AgentChatInputFocusedParams } from "./types.ts";

export class AgentChatInputFocusedReporter extends BaseAnalyticsReporter<AnalyticsReporterParams> {
  protected readonly eventName = "agent.chat_input_focused";

  constructor(
    params: AgentChatInputFocusedParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(
      {
        ...projectAgentChatEngagementBaseParams(params),
        focusMethod: params.focusMethod
      },
      dependencies
    );
  }
}
