import { createDecorator } from "@tutti-os/infra/di";

export interface WorkspaceAgentPromptSessionCreateInput {
  agentSessionId?: string | null;
  agentTargetId: string;
  cwd?: string | null;
  prompt: string;
  source?: string | null;
  title?: string | null;
  userProjectPath?: string | null;
  visible?: boolean;
  workspaceId: string;
}

export interface WorkspaceAgentPromptSessionCreateResult {
  agentSessionId: string;
  provider: string;
  status?: string | null;
}

export interface IWorkspaceAgentPromptSessionService {
  readonly _serviceBrand: undefined;

  createSession(
    input: WorkspaceAgentPromptSessionCreateInput
  ): Promise<WorkspaceAgentPromptSessionCreateResult>;
}

export const IWorkspaceAgentPromptSessionService =
  createDecorator<IWorkspaceAgentPromptSessionService>(
    "workspace-agent-prompt-session-service"
  );
