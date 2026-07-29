import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import type {
  AgentTarget,
  AgentTargetProvider,
  AgentTargetSource
} from "@tutti-os/client-tuttid-ts";

export type DesktopAgentDirectoryStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface DesktopAgentTargetPresentation {
  agentTargetId: string;
  createdAtUnixMs: number;
  enabled: boolean;
  iconKey?: string | null;
  iconUrl: string;
  maskIconUrl?: string | null;
  heroImageUrl?: string | null;
  availability: AgentGUIAgent["availability"];
  launchRefType: AgentTarget["launchRef"]["type"];
  name: string;
  provider: AgentTargetProvider;
  sortOrder: number;
  source: AgentTargetSource;
  updatedAtUnixMs: number;
}

export interface DesktopAgentDirectorySnapshot {
  agents: readonly AgentGUIAgent[];
  agentTargets: readonly DesktopAgentTargetPresentation[];
  capturedAtUnixMs: number | null;
  error: string | null;
  status: DesktopAgentDirectoryStatus;
}
