import { memo, useState } from "react";
import {
  AgentGUIConversationRailPane,
  type AgentGUIConversationRailControllerProps
} from "../view/AgentGUIConversationRailPane";
import { useAgentGUIConversationRailQuery } from "./useAgentGUIConversationRailQuery";

export const AgentGUIConversationRailController = memo(
  function AgentGUIConversationRailController(
    props: AgentGUIConversationRailControllerProps
  ): React.JSX.Element {
    const [conversationQuery, setConversationQuery] = useState("");
    const railQuery = useAgentGUIConversationRailQuery({
      activeConversationId: props.activeConversationId,
      conversationFilter: props.conversationFilter,
      conversationQuery,
      previewMode: props.previewMode,
      sectionAgentTargetFallbackId: props.sectionAgentTargetFallbackId,
      userProjects: props.userProjects,
      workspaceId: props.workspaceId
    });
    return (
      <AgentGUIConversationRailPane
        {...props}
        conversationQuery={conversationQuery}
        railQuery={railQuery}
        onConversationQueryChange={setConversationQuery}
      />
    );
  }
);
