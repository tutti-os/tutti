import type { JSX } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@tutti-os/ui-system";
import type {
  AgentConversationPromptVM,
  AgentInteractionResponseInput
} from "../contracts/agentConversationVM";
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
  isSubmitting: boolean;
  isInteractionDisabled?: boolean;
  interactionDisabledReason?: string | null;
  onSubmit: (input: AgentInteractionResponseInput) => boolean | void;
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
  isSubmitting,
  isInteractionDisabled = false,
  interactionDisabledReason = null,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  embedded?: boolean;
}): JSX.Element | null {
  "use memo";

  const submitPrompt = (
    input: AgentInteractionResponseInput
  ): boolean | void => {
    const agentSessionId =
      "agentSessionId" in prompt ? prompt.agentSessionId?.trim() : "";
    const turnId = "turnId" in prompt ? prompt.turnId?.trim() : "";
    return onSubmit({
      ...input,
      ...(agentSessionId && turnId ? { agentSessionId, turnId } : {}),
      requestId: prompt.requestId
    });
  };

  let promptSurface: JSX.Element;
  if (prompt.kind === "approval") {
    promptSurface = (
      <ApprovalPromptSurface
        prompt={prompt}
        embedded={embedded}
        edgeGlow={edgeGlow}
        keyboardShortcuts={keyboardShortcuts}
        isSubmitting={isSubmitting}
        isInteractionDisabled={isInteractionDisabled}
        onSubmit={submitPrompt}
        labels={labels}
      />
    );
  } else if (prompt.kind === "exit-plan") {
    promptSurface = (
      <ExitPlanPromptSurface
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        isSubmitting={isSubmitting}
        isInteractionDisabled={isInteractionDisabled}
        onSubmit={submitPrompt}
        labels={labels}
      />
    );
  } else if (prompt.kind === "plan-implementation") {
    promptSurface = (
      <PlanImplementationSurface
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        isSubmitting={isSubmitting}
        isInteractionDisabled={isInteractionDisabled}
        onSubmit={submitPrompt}
        labels={labels}
      />
    );
  } else {
    promptSurface = (
      <AgentAskUserPromptSurface
        key={prompt.requestId}
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        isSubmitting={isSubmitting}
        isInteractionDisabled={isInteractionDisabled}
        onSubmit={submitPrompt}
        labels={labels}
      />
    );
  }

  const normalizedReason = interactionDisabledReason?.trim() ?? "";
  if (!isInteractionDisabled || !normalizedReason) {
    return promptSurface;
  }

  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-disabled="true"
            aria-label={normalizedReason}
            className="cursor-not-allowed rounded-md outline-none"
            data-agent-interaction-disabled="true"
            role="group"
            tabIndex={0}
          >
            {/* Disabled form controls do not reliably dispatch pointer events.
                Keep the actual prompt out of hit testing so the wrapper can
                receive hover/focus events and expose the disabled reason. */}
            <div className="pointer-events-none">{promptSurface}</div>
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[min(360px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
        >
          {normalizedReason}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
