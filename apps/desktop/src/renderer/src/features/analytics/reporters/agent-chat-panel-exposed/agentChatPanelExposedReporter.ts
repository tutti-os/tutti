import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentChatPanelExposedParams } from "./types.ts";

export class AgentChatPanelExposedReporter extends BaseAnalyticsReporter<AgentChatPanelExposedParams> {
  protected readonly eventName = "agent.chat_panel_exposed";

  constructor(
    params: AgentChatPanelExposedParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
