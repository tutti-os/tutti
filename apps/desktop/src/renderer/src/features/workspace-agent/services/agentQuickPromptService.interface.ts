import { createDecorator } from "@tutti-os/infra/di";
import type { AgentHostQuickPromptsApi } from "@tutti-os/agent-gui";

export interface IAgentQuickPromptService extends AgentHostQuickPromptsApi {
  readonly _serviceBrand: undefined;
  dispose(): void;
}

export const IAgentQuickPromptService =
  createDecorator<IAgentQuickPromptService>("agent-quick-prompt-service");
