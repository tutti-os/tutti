import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies,
  type AnalyticsReporterParams
} from "../baseReporter.ts";
import { projectAgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";
import type { AgentChatPanelExposedParams } from "./types.ts";

export class AgentChatPanelExposedReporter extends BaseAnalyticsReporter<AnalyticsReporterParams> {
  protected readonly eventName = "agent.chat_panel_exposed";

  constructor(
    params: AgentChatPanelExposedParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(projectAgentChatEngagementBaseParams(params), dependencies);
  }
}
