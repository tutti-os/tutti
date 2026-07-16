import { memo } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tutti-os/ui-system";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import { conversationPlainTitle } from "./agentGUIViewUtils";
import styles from "../AgentGUINode.styles";

interface AgentGUIDetailHeaderProps {
  activeConversation: AgentGUINodeViewModel["rail"]["activeConversation"];
  hidden: boolean;
  labels: Pick<AgentGUIViewLabels, "untitledConversationTitle">;
  uiLanguage: UiLanguage;
  previewMode: boolean;
}

export const AgentGUIDetailHeader = memo(function AgentGUIDetailHeader({
  activeConversation,
  hidden,
  labels,
  uiLanguage,
  previewMode
}: AgentGUIDetailHeaderProps): React.JSX.Element | null {
  "use memo";

  if (hidden || !activeConversation) {
    return null;
  }

  const runPath = activeConversation.cwd.trim();
  return (
    <div className={styles.detailHeader}>
      <span className={styles.detailHeaderTitleGroup}>
        <span className={styles.detailHeaderTitle}>
          {conversationPlainTitle(activeConversation, labels, uiLanguage)}
        </span>
        {runPath ? (
          <AgentRunPathInfo path={runPath} previewMode={previewMode} />
        ) : null}
      </span>
    </div>
  );
});

function AgentRunPathInfo({
  path,
  previewMode
}: {
  path: string;
  previewMode: boolean;
}): React.JSX.Element {
  "use memo";

  const trigger = (
    <button
      type="button"
      className={styles.detailHeaderPathInfo}
      aria-label={path}
    >
      <Info size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  if (previewMode) {
    return trigger;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[320px] text-[11px] [overflow-wrap:anywhere]"
      >
        {path}
      </TooltipContent>
    </Tooltip>
  );
}

export type ChromeLabels = {
  approvalRequired: string;
  authRequired: string;
  activatingSession: string;
  retryActivation: string;
  continueInNewConversation: string;
};

export type InteractivePromptLabels = {
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
