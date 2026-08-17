import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies,
  type AnalyticsReporterParams
} from "../baseReporter.ts";
import { projectAgentChatEngagementBaseParams } from "../agent-chat-engagement-params.ts";
import type { AgentQuickPromptEngagementParams } from "./types.ts";

export class AgentQuickPromptEngagementReporter extends BaseAnalyticsReporter<AnalyticsReporterParams> {
  protected readonly eventName = "agent.quick_prompt_engagement";

  constructor(
    params: AgentQuickPromptEngagementParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(
      {
        ...projectAgentChatEngagementBaseParams(params),
        action: params.action,
        source: params.source,
        ...(params.action === "prompt_used"
          ? { promptType: params.promptType }
          : {})
      },
      dependencies
    );
  }
}
