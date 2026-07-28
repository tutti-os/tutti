import { memo } from "react";
import { ChevronsDown } from "lucide-react";
import { cn } from "@tutti-os/ui-system";
import styles from "../AgentGUINode.styles";
import { AgentInteractivePromptSurface } from "../AgentInteractivePromptSurface";
import { AgentComposerRegion } from "../AgentComposerRegion";
import { AgentSessionChrome } from "../AgentSessionChrome";
import { AgentComposer, type AgentComposerProps } from "../AgentComposer";
import {
  AgentGoalBanner,
  isGoalBannerVisible,
  type AgentGoalBannerLabels
} from "../AgentGoalBanner";
import {
  TuttiWorkflowDock,
  type TuttiWorkflowDockLabels
} from "../TuttiWorkflowDock";
import type {
  TuttiModePlanPanelLabels,
  TuttiPlanIssuePanelLabels
} from "../../../workspaceWorkflow";
import type {
  AgentGUINodeViewModel,
  AgentGUISessionChrome
} from "../model/agentGuiNodeTypes";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import type {
  ChromeLabels,
  InteractivePromptLabels
} from "./AgentGUINodeView.types";
import { numberValue, objectRecord, stringValue } from "./agentGUIViewUtils";
import type { AgentGUITuttiWorkflowDockController } from "./useAgentGUITuttiWorkflow";

interface AgentGUIBottomDockPaneProps {
  bottomDockRef: React.RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  scrollToBottomLabel: string;
  onScrollToBottom: () => void;
  // Approval / ask-user prompts lifted above the inline notice (composer stays
  // visible below). Mutually exclusive with bottomDockReplacementPrompt.
  bottomDockLiftedPrompt:
    | AgentGUINodeViewModel["interaction"]["pendingApproval"]
    | AgentGUINodeViewModel["interaction"]["pendingInteractivePrompt"];
  // When set, this interactive prompt takes the composer's slot in the bottom
  // dock (the composer is hidden). Closing the prompt returns the composer.
  bottomDockReplacementPrompt:
    | AgentGUINodeViewModel["interaction"]["pendingApproval"]
    | AgentGUINodeViewModel["interaction"]["pendingInteractivePrompt"];
  composerProps: AgentComposerProps;
  inlineNoticeChrome: AgentGUISessionChrome | null;
  isRespondingApproval: boolean;
  sessionChrome: AgentGUISessionChrome;
  keyboardShortcutsEnabled: boolean;
  chromeLabels: ChromeLabels;
  goalBannerLabels: AgentGoalBannerLabels;
  promptLabels: InteractivePromptLabels;
  onSubmitApprovalOption: AgentGUINodeViewProps["actions"]["submitApprovalOption"];
  onAuthLogin?: (provider?: string | null) => void;
  onRetryActivation: AgentGUINodeViewProps["actions"]["retryActivation"];
  onRetryInlineNotice: () => void;
  onContinueInNewConversation: AgentGUINodeViewProps["actions"]["continueInNewConversation"];
  onSubmitBottomDockInteractivePrompt: AgentGUINodeViewProps["actions"]["submitInteractivePrompt"];
  onGoalControl: AgentGUINodeViewProps["actions"]["goalControl"];
  goalPauseSupported: boolean;
  tuttiWorkflowDock: AgentGUITuttiWorkflowDockController;
  tuttiWorkflowDockLabels: TuttiWorkflowDockLabels;
  tuttiPlanPanelLabels: TuttiModePlanPanelLabels;
  tuttiPlanIssuePanelLabels: TuttiPlanIssuePanelLabels;
}

export const AgentGUIBottomDockPane = memo(function AgentGUIBottomDockPane({
  bottomDockRef,
  showScrollToBottom,
  scrollToBottomLabel,
  onScrollToBottom,
  bottomDockLiftedPrompt,
  bottomDockReplacementPrompt,
  composerProps,
  inlineNoticeChrome,
  isRespondingApproval,
  sessionChrome,
  keyboardShortcutsEnabled,
  chromeLabels,
  goalBannerLabels,
  promptLabels,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onRetryInlineNotice,
  onContinueInNewConversation,
  onSubmitBottomDockInteractivePrompt,
  onGoalControl,
  goalPauseSupported,
  tuttiWorkflowDock,
  tuttiWorkflowDockLabels,
  tuttiPlanPanelLabels,
  tuttiPlanIssuePanelLabels
}: AgentGUIBottomDockPaneProps): React.JSX.Element {
  "use memo";

  // Active thread goal rides the same runtimeContext channel as account /
  // rateLimits, so we read it straight off the session chrome's raw state.
  const goal = objectRecord(sessionChrome.rawState?.goal);
  const goalObjective = goal ? stringValue(goal.objective) : "";
  const goalStatus = goal ? stringValue(goal.status) : "";
  const goalTokenBudget = goal ? numberValue(goal.tokenBudget) : null;
  const goalTokensUsed = goal ? numberValue(goal.tokens) : null;
  const goalDurationMs = goal ? numberValue(goal.durationMs) : null;
  const goalIsOptimistic = sessionChrome.rawState?.goalIsOptimistic === true;
  const showGoalBanner = isGoalBannerVisible(goalObjective, goalStatus);

  const workflowPhase = tuttiWorkflowDock.phase;

  return (
    <AgentComposerRegion
      regionRef={bottomDockRef}
      floating={
        showScrollToBottom ? (
          <button
            type="button"
            className={cn(
              styles.bottomDockScrollToBottom,
              "nodrag tsh-desktop-no-drag [-webkit-app-region:no-drag]"
            )}
            data-testid="agent-gui-scroll-to-bottom"
            aria-label={scrollToBottomLabel}
            title={scrollToBottomLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onScrollToBottom}
          >
            <ChevronsDown aria-hidden="true" size={15} strokeWidth={2.2} />
          </button>
        ) : null
      }
      lifted={
        bottomDockLiftedPrompt ? (
          <div
            className={styles.bottomDockPrompt}
            data-testid="agent-gui-bottom-dock-active-prompt"
          >
            <AgentInteractivePromptSurface
              prompt={bottomDockLiftedPrompt}
              embedded={true}
              edgeGlow={true}
              keyboardShortcuts={keyboardShortcutsEnabled}
              isSubmitting={isRespondingApproval}
              onSubmit={onSubmitBottomDockInteractivePrompt}
              labels={promptLabels}
            />
          </div>
        ) : null
      }
      accessories={
        <>
          {inlineNoticeChrome ? (
            <AgentSessionChrome
              chrome={inlineNoticeChrome}
              isRespondingApproval={isRespondingApproval}
              onSubmitApprovalOption={onSubmitApprovalOption}
              onAuthLogin={onAuthLogin}
              onRetryActivation={onRetryInlineNotice}
              onContinueInNewConversation={onContinueInNewConversation}
              labels={chromeLabels}
            />
          ) : null}
          <AgentSessionChrome
            chrome={sessionChrome}
            isRespondingApproval={isRespondingApproval}
            onSubmitApprovalOption={onSubmitApprovalOption}
            onAuthLogin={onAuthLogin}
            onRetryActivation={onRetryActivation}
            onContinueInNewConversation={onContinueInNewConversation}
            labels={chromeLabels}
          />
          {showGoalBanner ? (
            <AgentGoalBanner
              objective={goalObjective}
              status={goalStatus}
              tokenBudget={goalTokenBudget ?? undefined}
              tokensUsed={goalTokensUsed ?? undefined}
              durationMs={goalDurationMs ?? undefined}
              optimistic={goalIsOptimistic}
              labels={goalBannerLabels}
              onPauseGoal={
                goalPauseSupported ? () => onGoalControl("pause") : undefined
              }
              onResumeGoal={
                goalPauseSupported ? () => onGoalControl("resume") : undefined
              }
              onClearGoal={() => onGoalControl("clear")}
            />
          ) : null}
          {workflowPhase ? (
            <TuttiWorkflowDock
              assignmentCatalog={tuttiWorkflowDock.assignmentCatalog}
              assignmentDrafts={tuttiWorkflowDock.assignmentDrafts}
              intensityPopoverLabels={{
                title: composerProps.labels.tuttiBudgetTitle,
                intensityLabel: composerProps.labels.tuttiBudgetIntensityLabel,
                previewTitle: composerProps.labels.tuttiBudgetPreviewTitle,
                previewHint: composerProps.labels.tuttiBudgetPreviewHint,
                previewCost: composerProps.labels.tuttiBudgetPreviewCost,
                previewBalance: composerProps.labels.tuttiBudgetPreviewBalance,
                previewPowerful:
                  composerProps.labels.tuttiBudgetPreviewPowerful,
                modelStrengthLabel:
                  composerProps.labels.tuttiBudgetModelStrengthLabel,
                modelStrengthCost:
                  composerProps.labels.tuttiBudgetModelStrengthCost,
                modelStrengthBalance:
                  composerProps.labels.tuttiBudgetModelStrengthBalance,
                modelStrengthPowerful:
                  composerProps.labels.tuttiBudgetModelStrengthPowerful,
                agentCountLabel:
                  composerProps.labels.tuttiBudgetAgentCountLabel,
                agentCountCost: composerProps.labels.tuttiBudgetAgentCountCost,
                agentCountBalance:
                  composerProps.labels.tuttiBudgetAgentCountBalance,
                agentCountPowerful:
                  composerProps.labels.tuttiBudgetAgentCountPowerful
              }}
              labels={tuttiWorkflowDockLabels}
              phase={workflowPhase}
              planPanelLabels={tuttiPlanPanelLabels}
              planIssuePanelLabels={tuttiPlanIssuePanelLabels}
              onAssignmentDraftChange={tuttiWorkflowDock.updateAssignment}
              onCancelExecution={tuttiWorkflowDock.cancelExecution}
              onCancelReview={tuttiWorkflowDock.cancelReview}
              onDecideTask={tuttiWorkflowDock.decideTask}
              onIntensityChange={tuttiWorkflowDock.changeIntensity}
              onOpenIssue={tuttiWorkflowDock.openIssue}
              onOpenTask={tuttiWorkflowDock.openTask}
              onRetry={tuttiWorkflowDock.retry}
            />
          ) : null}
        </>
      }
      primary={
        bottomDockReplacementPrompt ? (
          <div
            className={styles.bottomDockPrompt}
            data-testid="agent-gui-bottom-dock-active-prompt"
          >
            <AgentInteractivePromptSurface
              prompt={bottomDockReplacementPrompt}
              embedded={true}
              edgeGlow={true}
              keyboardShortcuts={keyboardShortcutsEnabled}
              isSubmitting={isRespondingApproval}
              onSubmit={onSubmitBottomDockInteractivePrompt}
              labels={promptLabels}
            />
          </div>
        ) : (
          <AgentComposer {...composerProps} />
        )
      }
    />
  );
});
