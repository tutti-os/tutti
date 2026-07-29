import type { JSX } from "react";
import { CheckCircle2 } from "lucide-react";
import { translate } from "../../../i18n/index";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import {
  AgentMessageMarkdown,
  type AgentMessageMarkdownWorkspaceAppIcon
} from "../../AgentMessageMarkdown";
import type { AgentTuttiPlanIssueLinkVM } from "../contracts/agentMessageRowVM";

// Friendly, non-error rendering for the daemon's durable plan→Issue reverse
// link (messageId "plan-issue:<issueID>"): a compact "Issue created from this
// plan" row with the workspace-issue mention rendered through the standard
// markdown mention-chip pipeline, so clicking it opens the Issue exactly like
// any other issue mention.
export function AgentTuttiPlanIssueLinkCard({
  planIssueLink,
  workspaceRoot,
  basePath,
  onLinkAction,
  workspaceAppIcons
}: {
  planIssueLink: AgentTuttiPlanIssueLinkVM;
  workspaceRoot: string | null;
  basePath: string;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}): JSX.Element {
  "use memo";
  const title = translate("agentHost.agentGui.tuttiModePlanIssueLinkCreated");
  return (
    <section
      data-testid="agent-tutti-plan-issue-link-card"
      data-plan-issue-id={planIssueLink.issueId}
      className="box-border w-full min-w-0 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CheckCircle2
          size={15}
          strokeWidth={2}
          aria-hidden="true"
          className="shrink-0 text-[var(--text-secondary)]"
        />
        <span className="shrink-0 text-[13px] font-medium text-[var(--text-primary)]">
          {title}
        </span>
        <span className="min-w-0">
          <AgentMessageMarkdown
            inline
            content={planIssueLink.mentionMarkdown}
            onLinkAction={onLinkAction}
            workspaceLinkContext={{
              workspaceRoot,
              basePath,
              source: "agent-markdown"
            }}
            workspaceAppIcons={workspaceAppIcons}
          />
        </span>
      </div>
    </section>
  );
}
