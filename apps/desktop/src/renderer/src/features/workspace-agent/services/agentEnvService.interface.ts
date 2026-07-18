import { createDecorator } from "@tutti-os/infra/di";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  OpenAgentEnvPanelInput,
  StageActionId
} from "@tutti-os/agent-gui/agent-env";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";

export type AgentEnvReportState =
  | "idle"
  | "confirming"
  | "reported"
  | "dismissed";

export interface AgentEnvSnapshot {
  copied: boolean;
  installPending: boolean;
  isLoading: boolean;
  isSupported: boolean;
  logExpanded: boolean;
  loginPending: boolean;
  open: boolean;
  provider: WorkspaceAgentProvider;
  reportState: AgentEnvReportState;
  requestSequence: number;
  revealIndex: number;
  status: AgentProviderStatus | null;
}

export interface IAgentEnvService {
  readonly _serviceBrand: undefined;

  getSnapshot(): AgentEnvSnapshot;
  subscribe(listener: () => void): () => void;
  bindWorkbenchHost(host: WorkbenchHostHandle): () => void;
  open(input?: OpenAgentEnvPanelInput): void;
  close(): void;
  redetect(): void;
  runStageAction(actionId: StageActionId): Promise<void>;
  confirmReport(): void;
  dismissReport(): void;
  copyManual(command: string): Promise<void>;
  toggleLog(): void;
  dispose(): void;
}

export const IAgentEnvService =
  createDecorator<IAgentEnvService>("agent-env-service");
