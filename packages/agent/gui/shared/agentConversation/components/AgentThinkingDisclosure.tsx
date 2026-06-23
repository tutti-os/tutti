import type { JSX } from "react";
import { WorkspaceAgentSessionThinkingDisclosure } from "../../WorkspaceAgentSessionThinkingDisclosure";
import type { AgentThinkingContentVM } from "../contracts/agentMessageRowVM";
import { RawTimelineJsonDisclosure } from "./RawTimelineJsonDisclosure";

interface AgentThinkingDisclosureProps {
  thinking: AgentThinkingContentVM;
  label: string;
  onLinkClick?: (href: string) => void;
  previewMode?: boolean;
  showRawTimelineJson?: boolean;
  rawTimelineJsonLabel?: string;
}

export function AgentThinkingDisclosure({
  thinking,
  label,
  onLinkClick,
  previewMode = false,
  showRawTimelineJson = false,
  rawTimelineJsonLabel = ""
}: AgentThinkingDisclosureProps): JSX.Element {
  "use memo";

  return (
    <>
      <WorkspaceAgentSessionThinkingDisclosure
        thinking={thinking}
        label={label}
        onLinkClick={onLinkClick}
        previewMode={previewMode}
      />
      {showRawTimelineJson && rawTimelineJsonLabel ? (
        <RawTimelineJsonDisclosure
          items={thinking.sourceTimelineItems}
          label={rawTimelineJsonLabel}
        />
      ) : null}
    </>
  );
}
