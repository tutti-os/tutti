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
  getSnapshotForTarget(
    agentTargetId: string | null | undefined
  ): AgentCLIUpdateNoticeSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Lets the window activation coordinator reuse update discovery as the
   * provider-status refresh for this activation. Returns true when a request
   * handled the activation.
   */
  refreshForWindowActivation(): Promise<boolean>;
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
