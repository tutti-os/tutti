import { useCallback, type JSX } from "react";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../AgentMessageMarkdown";
import { AgentRichTextReadonly } from "../../AgentRichTextReadonly";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import type { AgentGUIProviderSkillOption } from "../../../agent-gui/agentGuiNode/model/agentGuiNodeTypes";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import type { AgentGoalControlRowVM } from "../contracts/agentGoalControlRowVM";
import { AgentCopyableMessageGroup } from "./AgentMessageActions";

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
  const agentHostApi = useOptionalAgentHostApi();
  const handleCopyMessageText = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.trim()) {
        return false;
      }

      try {
        const hostWriteText = agentHostApi?.clipboard?.writeText;
        if (typeof hostWriteText === "function") {
          await hostWriteText(text);
          return true;
        }
        if (
          typeof navigator !== "undefined" &&
          typeof navigator.clipboard?.writeText === "function"
        ) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    [agentHostApi]
  );
  return (
    <div
      className={styles.userMessageFlow}
      data-agent-goal-control-action={row.action}
    >
      <AgentCopyableMessageGroup
        copyText={row.body.trim() ? row.body : null}
        editAction={null}
        occurredAtUnixMs={row.occurredAtUnixMs}
        onCopyMessageText={handleCopyMessageText}
        speaker="user"
      >
        <AgentRichTextReadonly
          value={row.body}
          className={`workspace-agents-status-panel__detail-user-message ${styles.userMessageBubble}`}
          editorClassName="text-[inherit]"
          availableSkills={availableSkills}
          workspaceAppIcons={workspaceAppIcons}
        />
      </AgentCopyableMessageGroup>
    </div>
  );
}
