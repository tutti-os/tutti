import { useMemo, type ReactNode } from "react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import type {
  AgentGUIAgentDirectoryPort,
  AgentGUIAgentDirectorySnapshot
} from "../types.ts";
import { useEngineSelector } from "../shared/engine/useEngineSelector.ts";
import {
  agentGuiWorkbenchConversationIdentitiesEqual,
  resolveAgentGuiWorkbenchConversationIdentity
} from "./conversationIdentity.ts";
import {
  AgentGuiWorkbenchHeader,
  type AgentGuiWorkbenchHeaderProps
} from "./header.ts";
import type {
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState
} from "./types.ts";

interface AgentGuiWorkbenchReactiveHeaderProps extends Omit<
  AgentGuiWorkbenchHeaderProps,
  "agentTitle" | "conversationIconUrl" | "conversationTitle"
> {
  agentDirectory: AgentGUIAgentDirectoryPort;
  dockIconUrls?: Partial<Record<AgentGuiWorkbenchProvider, string>>;
  sessionEngine: AgentSessionEngine;
  workbenchState: AgentGuiWorkbenchState | null;
}

export function AgentGuiWorkbenchReactiveHeader({
  agentDirectory,
  dockIconUrls,
  sessionEngine,
  workbenchState,
  ...headerProps
}: AgentGuiWorkbenchReactiveHeaderProps): ReactNode {
  const directoryStore = useMemo(
    () => ({
      getSnapshot: () => agentDirectory.getSnapshot(),
      subscribe: (
        listener: (snapshot: AgentGUIAgentDirectorySnapshot) => void
      ) =>
        agentDirectory.subscribe(() => {
          listener(agentDirectory.getSnapshot());
        })
    }),
    [agentDirectory]
  );
  const agents = useEngineSelector(
    directoryStore,
    (snapshot) => snapshot.agents,
    Object.is
  );
  const conversationIdentity = useEngineSelector(
    sessionEngine,
    (engineState) =>
      resolveAgentGuiWorkbenchConversationIdentity({
        agents,
        dockIconUrls,
        engineState,
        workbenchState
      }),
    agentGuiWorkbenchConversationIdentitiesEqual
  );

  return (
    <AgentGuiWorkbenchHeader
      {...headerProps}
      agentTitle={conversationIdentity?.agentTitle}
      conversationIconUrl={
        conversationIdentity?.iconUrl ?? headerProps.conversationIconFallbackUrl
      }
      conversationTitle={conversationIdentity?.title}
    />
  );
}
