import type { ComponentProps } from "react";
import { useAgentConversationMinuteNowUnixMs } from "../../../shared/agentConversation/components/AgentConversationClock";
import { ConversationMeta } from "../agentGuiNodeViewConversation";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";

export function AgentGUIConversationRailRelativeTime({
  item,
  labels,
  hideTime
}: {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  labels: ComponentProps<typeof ConversationMeta>["labels"];
  hideTime?: boolean;
}): React.JSX.Element {
  if (hideTime) {
    return <ConversationMeta hideTime item={item} nowMs={0} labels={labels} />;
  }
  return (
    <AgentGUIConversationRailRelativeTimeWithClock
      item={item}
      labels={labels}
    />
  );
}

function AgentGUIConversationRailRelativeTimeWithClock({
  item,
  labels
}: {
  item: AgentGUINodeViewModel["rail"]["conversations"][number];
  labels: ComponentProps<typeof ConversationMeta>["labels"];
}): React.JSX.Element {
  const currentTimeMs = useAgentConversationMinuteNowUnixMs();
  return <ConversationMeta item={item} nowMs={currentTimeMs} labels={labels} />;
}
