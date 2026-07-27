import { useMemo, useState } from "react";
import type { AgentComposerProps } from "../AgentComposer";
import { createAgentComposerInputHistoryStore } from "../model/agentComposerInputHistory";

type InputHistoryProps = Pick<AgentComposerProps, "inputHistoryStore">;

export function useAgentGUIComposerInputHistoryProps(input: {
  enabled: boolean;
}): InputHistoryProps {
  const [inputHistoryStore] = useState(createAgentComposerInputHistoryStore);
  return useMemo(
    () => ({
      inputHistoryStore: input.enabled ? inputHistoryStore : undefined
    }),
    [input.enabled, inputHistoryStore]
  );
}
