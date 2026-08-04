import type {
  AgentGUIProviderUpdateNotice,
  AgentGUIProviderUpdateNoticeAction
} from "@tutti-os/agent-gui";
import { createDecorator } from "@tutti-os/infra/di";

export interface AgentCLIUpdateNoticeSnapshot {
  notices: readonly AgentGUIProviderUpdateNotice[];
}

export interface IAgentCLIUpdateNoticeService {
  readonly _serviceBrand: undefined;

  getSnapshot(): AgentCLIUpdateNoticeSnapshot;
  subscribe(listener: () => void): () => void;
  setSurfaceEligible(surfaceId: string, eligible: boolean): void;
  releaseSurface(surfaceId: string): void;
  runAction(input: {
    action: AgentGUIProviderUpdateNoticeAction;
    notice: AgentGUIProviderUpdateNotice;
  }): Promise<void>;
  dispose(): void;
}

export const IAgentCLIUpdateNoticeService =
  createDecorator<IAgentCLIUpdateNoticeService>(
    "agent-cli-update-notice-service"
  );
