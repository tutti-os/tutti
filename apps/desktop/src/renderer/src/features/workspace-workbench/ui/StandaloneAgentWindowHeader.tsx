import { useMemo, type ComponentProps, type ReactNode } from "react";
import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
import { useEngineSelector, type AgentGUIAgent } from "@tutti-os/agent-gui";
import {
  AgentGuiWorkbenchHeader,
  agentGuiWorkbenchConversationIdentitiesEqual,
  resolveAgentGuiWorkbenchConversationIdentity
} from "@tutti-os/agent-gui/workbench";
import type { IWorkspaceAgentActivityService as WorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import type {
  DesktopAgentGUIProvider,
  DesktopAgentGUIWorkbenchState
} from "@renderer/features/workspace-agent/desktopAgentGUINodeState.ts";
import { resolveStandaloneAgentHeaderIdentity } from "./standaloneAgentHeaderIdentity.ts";

export interface StandaloneAgentWindowHeaderIdentity {
  agentTitle: string | null;
  conversationIconFallbackUrl: string | null;
  conversationIconUrl: string | null;
  conversationTitle: string | null;
  hasConversation: boolean;
  provider: DesktopAgentGUIProvider;
}

export function useStandaloneAgentWindowHeaderIdentity(input: {
  activeAgentTargetId: string | null;
  agents: readonly AgentGUIAgent[];
  fallbackProvider: DesktopAgentGUIProvider;
  nodeState: DesktopAgentGUIWorkbenchState;
  sessions: readonly AgentActivitySession[];
  workspaceAgentActivityService: WorkspaceAgentActivityService;
  workspaceId: string;
}): StandaloneAgentWindowHeaderIdentity {
  const sessionEngine = useMemo(
    () =>
      input.workspaceAgentActivityService.getSessionEngine(input.workspaceId),
    [input.workspaceAgentActivityService, input.workspaceId]
  );
  const engineConversationIdentity = useEngineSelector(
    sessionEngine,
    (engineState) =>
      resolveAgentGuiWorkbenchConversationIdentity({
        agents: input.agents,
        engineState,
        workbenchState: input.nodeState
      }),
    agentGuiWorkbenchConversationIdentitiesEqual
  );
  const snapshotIdentity = resolveStandaloneAgentHeaderIdentity({
    agentTargetId: input.activeAgentTargetId,
    agents: input.agents,
    fallbackProvider: input.fallbackProvider,
    lastActiveAgentSessionId: input.nodeState.lastActiveAgentSessionId,
    sessions: input.sessions
  });
  return {
    ...snapshotIdentity,
    conversationTitle:
      engineConversationIdentity?.title ?? snapshotIdentity.conversationTitle,
    hasConversation: Boolean(input.nodeState.lastActiveAgentSessionId?.trim())
  };
}

type AgentGuiWorkbenchHeaderProps = ComponentProps<
  typeof AgentGuiWorkbenchHeader
>;

export interface StandaloneAgentWindowHeaderProps extends Omit<
  AgentGuiWorkbenchHeaderProps,
  | "agentTitle"
  | "conversationIconFallbackUrl"
  | "conversationIconUrl"
  | "conversationTitle"
  | "hasConversation"
> {
  identity: StandaloneAgentWindowHeaderIdentity;
}

export function StandaloneAgentWindowHeader({
  identity,
  ...props
}: StandaloneAgentWindowHeaderProps): ReactNode {
  return (
    <AgentGuiWorkbenchHeader
      {...props}
      agentTitle={identity.agentTitle}
      conversationIconFallbackUrl={identity.conversationIconFallbackUrl}
      conversationIconUrl={identity.conversationIconUrl}
      conversationTitle={identity.conversationTitle}
      hasConversation={identity.hasConversation}
    />
  );
}
