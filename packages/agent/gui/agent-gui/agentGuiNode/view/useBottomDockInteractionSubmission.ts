import { useCallback } from "react";
import type { AgentComposerProps } from "../AgentComposer";
import { submitAgentInteractionResponseAndDismiss } from "../../../shared/agentConversation/interactionResponseAdmission";

export function useBottomDockInteractionSubmission(
  submit: AgentComposerProps["onSubmitInteractivePrompt"],
  dismiss: (requestId: string) => void
) {
  return useCallback(
    (response: Parameters<typeof submit>[0]) =>
      submitAgentInteractionResponseAndDismiss({ response, submit, dismiss }),
    [dismiss, submit]
  );
}
