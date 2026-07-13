import { createDecorator } from "@tutti-os/infra/di";
import type {
  DesktopAgentDirectorySnapshot,
  DesktopAgentTargetPresentation
} from "@shared/contracts/agentDirectory.ts";

export type AgentsSnapshot = DesktopAgentDirectorySnapshot;
export type AgentTargetPresentation = DesktopAgentTargetPresentation;

export interface IAgentsService {
  readonly _serviceBrand: undefined;

  getSnapshot(): AgentsSnapshot;
  getAgentTarget(input: {
    agentTargetId: string;
  }): AgentTargetPresentation | null;
  hydrate(snapshot: AgentsSnapshot): void;
  load(signal?: AbortSignal): Promise<AgentsSnapshot>;
  refresh(signal?: AbortSignal): Promise<AgentsSnapshot>;
  subscribe(listener: () => void): () => void;
}

export const IAgentsService = createDecorator<IAgentsService>(
  "workspace-agents-service"
);
