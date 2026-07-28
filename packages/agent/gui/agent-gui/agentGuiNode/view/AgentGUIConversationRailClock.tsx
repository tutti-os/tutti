import type { ComponentProps } from "react";
import { useAgentConversationMinuteNowUnixMs } from "../../../shared/agentConversation/components/AgentConversationClock";
import { ConversationMeta } from "../agentGuiNodeViewConversation";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";

export function AgentGUIConversationRailRelativeTime({
  item,
  labels
}: {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  labels: ComponentProps<typeof ConversationMeta>["labels"];
}): React.JSX.Element {
  const currentTimeMs = useAgentConversationMinuteNowUnixMs();
  return <ConversationMeta item={item} nowMs={currentTimeMs} labels={labels} />;
}
