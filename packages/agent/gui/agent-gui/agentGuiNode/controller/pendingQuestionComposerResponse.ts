import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import type { AgentInteractionResponseInput } from "../../../shared/agentConversation/contracts/agentConversationVM";
import { normalizeAskUserQuestions } from "../../../shared/agentConversation/askUserQuestions";
import { buildAskUserComposerAnswerPayload } from "../../../shared/agentConversation/interactiveAnswerPayload";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import { agentPromptContentDisplayText } from "../model/agentComposerDraft";

export function resolvePendingQuestionComposerResponse(input: {
  activeTurnId: string;
  agentSessionId: string;
  content: readonly AgentPromptContentBlock[];
  pendingInteractions: readonly AgentActivityInteraction[];
}): AgentInteractionResponseInput | null {
  const activeTurnId = input.activeTurnId.trim();
  const agentSessionId = input.agentSessionId.trim();
  if (
    !activeTurnId ||
    !agentSessionId ||
    input.content.length === 0 ||
    input.content.some((block) => block.type !== "text")
  ) {
    return null;
  }
  const matching = input.pendingInteractions.filter(
    (interaction) =>
      interaction.status === "pending" &&
      interaction.kind === "question" &&
      interaction.agentSessionId.trim() === agentSessionId &&
      interaction.turnId.trim() === activeTurnId
  );
  if (matching.length !== 1) return null;

  const interaction = matching[0]!;
  const questions = normalizeAskUserQuestions(interaction.input?.questions);
  if (
    questions.length === 0 ||
    questions.some((question) => question.allowFreeText === false)
  ) {
    return null;
  }
  const payload = buildAskUserComposerAnswerPayload(
    questions.map((question) => question.id),
    agentPromptContentDisplayText(input.content)
  );
  if (!payload) return null;
  return {
    action: "submit",
    agentSessionId,
    payload: { ...payload },
    requestId: interaction.requestId,
    turnId: activeTurnId
  };
}
