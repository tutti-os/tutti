import type { AgentInteractionResponseInput } from "./contracts/agentConversationVM";

export function submitAgentInteractionResponseAndDismiss(input: {
  response: AgentInteractionResponseInput;
  submit(response: AgentInteractionResponseInput): boolean;
  dismiss(requestId: string): void;
}): boolean {
  const admitted = input.submit(input.response);
  if (admitted) {
    input.dismiss(input.response.requestId);
  }
  return admitted;
}
