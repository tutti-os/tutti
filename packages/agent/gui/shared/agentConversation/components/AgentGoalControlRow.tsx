import type { JSX } from "react";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import { AgentRichTextReadonly } from "../../AgentRichTextReadonly";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import type { AgentGoalControlRowVM } from "../contracts/agentGoalControlRowVM";

interface AgentGoalControlRowProps {
  row: AgentGoalControlRowVM;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  workspaceAppIcons?: readonly AgentMessageMarkdownWorkspaceAppIcon[];
}

export function AgentGoalControlRow({
  row,
  availableSkills,
  workspaceAppIcons
}: AgentGoalControlRowProps): JSX.Element {
  "use memo";
  return (
    <div
      className={styles.userMessageFlow}
      data-agent-goal-control-action={row.action}
    >
      <AgentRichTextReadonly
        value={row.body}
        className={`workspace-agents-status-panel__detail-user-message ${styles.userMessageBubble}`}
        editorClassName="text-[inherit]"
        availableSkills={availableSkills}
        workspaceAppIcons={workspaceAppIcons}
      />
    </div>
  );
}
