import { createDecorator } from "@tutti-os/infra/di";
import type {
  AgentTarget,
  AgentTargetProvider,
  AgentTargetSource
} from "@tutti-os/client-tuttid-ts";
import type { AgentGUIProviderTarget } from "@tutti-os/agent-gui";

export interface AgentTargetPresentation {
  agentTargetId: string;
  createdAtUnixMs: number;
  enabled: boolean;
  iconKey?: string | null;
  iconUrl: string;
  launchRefType: AgentTarget["launchRef"]["type"];
  name: string;
  provider: AgentTargetProvider;
  sortOrder: number;
  source: AgentTargetSource;
  updatedAtUnixMs: number;
}

export interface AgentsSnapshot {
  agentTargets: readonly AgentTargetPresentation[];
  capturedAtUnixMs: number | null;
  providerTargets: readonly AgentGUIProviderTarget[];
}

export interface IAgentsService {
  readonly _serviceBrand: undefined;

  getSnapshot(): AgentsSnapshot;
  getAgentTarget(input: {
    agentTargetId: string;
  }): AgentTargetPresentation | null;
  load(signal?: AbortSignal): Promise<AgentsSnapshot>;
  refresh(signal?: AbortSignal): Promise<AgentsSnapshot>;
  subscribe(listener: () => void): () => void;
}

export const IAgentsService = createDecorator<IAgentsService>(
  "workspace-agents-service"
);
