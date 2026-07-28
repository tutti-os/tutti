import {
  resolveWorkspaceLinkAction,
  type WorkspaceLinkAction,
  type WorkspaceLinkActionSource
} from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import type { AgentConversationVM } from "../contracts/agentConversationVM";

export type { WorkspaceLinkAction, WorkspaceLinkActionSource };

export function resolveAgentConversationLinkAction({
  workspaceRoot,
  basePath,
  href,
  source
}: {
  workspaceRoot: AgentConversationVM["workspaceRoot"];
  basePath: AgentConversationVM["sourceDetail"]["cwd"];
  href: string;
  source: WorkspaceLinkActionSource;
}): WorkspaceLinkAction | null {
  return resolveWorkspaceLinkAction({
    href,
    workspaceRoot: workspaceRoot,
    basePath,
    source
  });
}
