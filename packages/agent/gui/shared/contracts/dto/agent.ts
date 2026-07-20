export type AgentProviderId =
  | "claude-code"
  | "codex"
  | "tutti-agent"
  | "cursor"
  | "nexight"
  | "opencode"
  | "openclaw"
  | "hermes";

export type AgentModelCatalogSource =
  | "codex-cli"
  | "tutti-agent-cli"
  | "nexight-cli"
  | "opencode-cli"
  | "openclaw-cli"
  | "hermes-cli";
import type { AppErrorDescriptor } from "./error";
import type { TerminalRuntimeKind } from "./terminal";

export type AgentLaunchMode = "new" | "resume";

export interface ListAgentModelsInput {
  provider: AgentProviderId;
  refresh?: boolean;
}

export interface ListInstalledAgentProvidersResult {
  providers: AgentProviderId[];
}

export interface AgentModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface ListAgentModelsResult {
  provider: AgentProviderId;
  source: AgentModelCatalogSource;
  fetchedAt: string;
  models: AgentModelOption[];
  error: AppErrorDescriptor | null;
}

export interface LaunchAgentResult {
  sessionId: string;
  provider: AgentProviderId;
  profileId?: string | null;
  runtimeKind?: TerminalRuntimeKind;
  command: string;
  args: string[];
  launchMode: AgentLaunchMode;
  effectiveModel: string | null;
  resumeSessionId: string | null;
}
