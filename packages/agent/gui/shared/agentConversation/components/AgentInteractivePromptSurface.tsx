import type { JSX } from "react";
import type { AgentConversationPromptVM } from "../contracts/agentConversationVM";
import { AgentAskUserPromptSurface } from "./AgentAskUserPromptSurface";
import {
  ApprovalPromptSurface,
  ExitPlanPromptSurface,
  PlanImplementationSurface
} from "./AgentInteractiveDecisionPromptSurfaces";

/**
 * Where the prompt is rendered, which sets its interaction budget:
 * - "full" (conversation / composer): the user is focused here, so every action
 *   is shown — primary decisions plus rich follow-ups (feedback textareas,
 *   multi-step wizards, "stay in plan").
 * - "compact" (message-center attention deck): a glanceable needs-attention card
 *   across many sessions. Ask-user prompts retain the full answer flow in a
 *   denser layout; other prompt kinds may intentionally limit secondary actions.
 */
export type AgentInteractivePromptVariant = "full" | "compact";

export interface AgentInteractivePromptSurfaceProps {
  prompt: AgentConversationPromptVM;
  variant?: AgentInteractivePromptVariant;
  edgeGlow?: boolean;
  keyboardShortcuts?: boolean;
  previewMode?: boolean;
  isSubmitting: boolean;
  onSubmit: (input: {
    requestId: string;
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }) => void;
  labels: {
    approvalLead: string;
    fileChangeApprovalLead: string;
    planLead: string;
    planModes: Array<{ id: string; label: string; description: string }>;
    stayInPlan: string;
    sendFeedback: string;
    feedbackPlaceholder: string;
    previousQuestion: string;
    nextQuestion: string;
    submitAnswers: string;
    answerPlaceholder: string;
    waitingForAnswer: string;
    planImplementationLead: string;
    planImplementationConfirm: string;
    planImplementationFeedbackPlaceholder: string;
    planImplementationSend: string;
    planImplementationSkip: string;
  };
}

export function AgentInteractivePromptSurface({
  prompt,
  variant = "full",
  edgeGlow = false,
  embedded = false,
  keyboardShortcuts = true,
  previewMode = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  embedded?: boolean;
}): JSX.Element | null {
  "use memo";

  if (prompt.kind === "approval") {
    return (
      <ApprovalPromptSurface
        prompt={prompt}
        embedded={embedded}
        edgeGlow={edgeGlow}
        keyboardShortcuts={keyboardShortcuts}
        previewMode={previewMode}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  if (prompt.kind === "exit-plan") {
    return (
      <ExitPlanPromptSurface
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        previewMode={previewMode}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  if (prompt.kind === "plan-implementation") {
    return (
      <PlanImplementationSurface
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        previewMode={previewMode}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  return (
    <AgentAskUserPromptSurface
      key={prompt.requestId}
      prompt={prompt}
      variant={variant}
      embedded={embedded}
      edgeGlow={edgeGlow}
      isSubmitting={isSubmitting}
      onSubmit={onSubmit}
      labels={labels}
    />
  );
}
