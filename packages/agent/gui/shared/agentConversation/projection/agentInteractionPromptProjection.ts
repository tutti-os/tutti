import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import type { AgentConversationPromptVM } from "../contracts/agentConversationVM";
import { normalizeAgentApprovalPurpose } from "../agentApprovalPurpose";
import { normalizeAskUserQuestions } from "../askUserQuestions";
import {
  extractExitPlanKeepPlanningOptionId,
  extractExitPlanModeOptions
} from "../exitPlanOptions";
import { normalizeAgentApprovalOptions } from "./agentApprovalProjection";

type ApprovalPrompt = Extract<AgentConversationPromptVM, { kind: "approval" }>;
type InteractivePrompt = Exclude<
  AgentConversationPromptVM,
  ApprovalPrompt | { kind: "plan-implementation" }
>;

export function projectAgentConversationPromptFromInteraction(
  interaction: AgentActivityInteraction
): ApprovalPrompt | InteractivePrompt | null {
  return interaction.kind === "approval"
    ? projectAgentApprovalPromptFromInteraction(interaction)
    : projectAgentInteractivePromptFromInteraction(interaction);
}

export function projectAgentApprovalPromptFromInteraction(
  interaction: AgentActivityInteraction | null
): ApprovalPrompt | null {
  if (!interaction || interaction.kind !== "approval") return null;
  const callId =
    typeof interaction.input?.callId === "string" &&
    interaction.input.callId.trim()
      ? interaction.input.callId.trim()
      : interaction.requestId.trim();
  const options = normalizeAgentApprovalOptions(interaction.input?.options);
  if (!callId || options.length === 0) return null;
  const approvalPurpose = normalizeAgentApprovalPurpose(
    interaction.metadata?.approvalPurpose
  );
  return {
    kind: "approval",
    id: `approval:${callId}`,
    turnId: interaction.turnId,
    requestId: interaction.requestId,
    callId,
    ...(approvalPurpose ? { approvalPurpose } : {}),
    title: interaction.toolName?.trim() || "",
    status: "waiting_approval",
    toolName: interaction.toolName?.trim() || null,
    input: interaction.input ?? null,
    options,
    output: interaction.output ?? null,
    occurredAtUnixMs: interaction.createdAtUnixMs
  };
}

export function projectAgentInteractivePromptFromInteraction(
  interaction: AgentActivityInteraction | null
): InteractivePrompt | null {
  if (!interaction || interaction.kind === "approval") return null;
  const toolName = normalizeInteractiveToolName(
    interaction.toolName ?? undefined
  );
  if (interaction.kind === "plan" || toolName === "exitplanmode") {
    const keepPlanningOptionId = extractExitPlanKeepPlanningOptionId(
      interaction.input
    );
    return {
      kind: "exit-plan",
      requestId: interaction.requestId,
      title: interaction.toolName?.trim() || "",
      options: extractExitPlanModeOptions(interaction.input),
      ...(keepPlanningOptionId ? { keepPlanningOptionId } : {})
    };
  }
  if (interaction.kind !== "question" || toolName !== "askuserquestion") {
    return null;
  }
  const questions = normalizeAskUserQuestions(interaction.input?.questions, {
    missingText: ""
  });
  return questions.length > 0
    ? {
        kind: "ask-user",
        requestId: interaction.requestId,
        title: interaction.toolName?.trim() || "",
        questions
      }
    : null;
}

function normalizeInteractiveToolName(toolName: string | undefined): string {
  return (toolName?.trim() ?? "").replace(/[_\s-]+/g, "").toLowerCase();
}
