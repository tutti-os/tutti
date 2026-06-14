import { createDecorator } from "@tutti-os/infra/di";
import type {
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  AgentProviderTerminalCommand,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";

export interface AgentProviderStatusActionContext {
  workbenchHost?: unknown;
  workspaceId?: string;
}

export interface AgentProviderTerminalCommandRunner {
  runTerminalCommand(
    command: AgentProviderTerminalCommand,
    context?: AgentProviderStatusActionContext
  ): Promise<void>;
}

export interface AgentProviderStatusPendingAction {
  actionId: string;
  provider: WorkspaceAgentProvider;
}

export interface AgentProviderStatusSnapshot {
  error: string | null;
  isLoading: boolean;
  pendingActions: readonly AgentProviderStatusPendingAction[];
  statuses: readonly AgentProviderStatus[];
  capturedAt: string | null;
  defaultProvider: WorkspaceAgentProvider | null;
}

export interface IAgentProviderStatusService {
  readonly _serviceBrand: undefined;

  getRevision(): number;
  getSnapshot(): AgentProviderStatusSnapshot;
  isActionPending(provider: WorkspaceAgentProvider, actionId: string): boolean;
  getStatus(provider: WorkspaceAgentProvider): AgentProviderStatus | null;
  ensureLoaded(input?: {
    providers?: WorkspaceAgentProvider[];
  }): Promise<AgentProviderStatusListResponse | null>;
  runAction(
    provider: WorkspaceAgentProvider,
    actionId: string,
    context?: AgentProviderStatusActionContext
  ): Promise<void>;
  refresh(providers?: WorkspaceAgentProvider[]): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export const IAgentProviderStatusService =
  createDecorator<IAgentProviderStatusService>("agent-provider-status-service");
