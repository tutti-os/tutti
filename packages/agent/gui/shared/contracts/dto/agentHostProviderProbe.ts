import type { AgentHostToolchainApplySummary } from "./agentHostWorkspace";

export interface AgentHostCapabilitiesResult {
  desktopMode: boolean;
  mockAuth: boolean;
  roomListMode: string;
  platforms: string[];
  /** Short hostname from desktopd for device-centric copy (e.g. Manage Agents). */
  hostDisplayName?: string;
}

export interface AgentHostManagedAgentsStateItem {
  toolId: string;
  toolClass: string;
  agentId?: string;
  hostDetected?: boolean;
  hostConfigDetected?: boolean;
  hostVersion?: string;
  targetVersion: string;
  recommendedVersion?: string;
  decisionReason: string;
  fallbackApplied: boolean;
  notes?: string;
}

export interface AgentHostToolchainConfigSyncedAgent {
  agentId: string;
  /** RFC3339 timestamp for when Tutti last synced this agent's host config. */
  syncedAt?: string;
}

export interface AgentHostManagedAgentsState {
  metadataSynced: boolean;
  toolCatalogRevision: string;
  agentProfileRevision: string;
  totalCount: number;
  items: AgentHostManagedAgentsStateItem[];
  /** Agent IDs ready for normal AgentGUI use (installed and authenticated/ready). */
  readyAgentIds: string[];
  /** Agent IDs whose host config has been synced to the VM through Manage Agents. */
  configSyncedAgentIds: string[];
  /** Agent config sync metadata, including when Tutti last copied host config. */
  configSyncedAgents?: AgentHostToolchainConfigSyncedAgent[];
}

export type AgentHostManageAgentActionKind = "sync" | "install" | "uninstall";

export interface AgentHostManageToolchainAgentInput {
  agentId: string;
  action: AgentHostManageAgentActionKind;
}

export interface AgentHostManageToolchainAgentResult {
  applied: boolean;
  alreadyUninstalled?: boolean;
  toolchainApply?: AgentHostToolchainApplySummary;
  /** Agent IDs ready for normal AgentGUI use after applying this action. */
  readyAgentIds?: string[];
  configSyncedAgentIds?: string[];
  configSyncedAgents?: AgentHostToolchainConfigSyncedAgent[];
}

export type AgentHostConnectorMCPTransport = "stdio" | "sse" | "http";

export interface AgentHostConnectorMCPServer {
  id: string;
  name?: string;
  description?: string;
  installStatus?: "ready" | "failed" | "skipped";
  installMessage?: string;
  transport: AgentHostConnectorMCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  agents?: string[];
  source?: "builtin" | "user";
}

export interface AgentHostConnectorMCPRegistry {
  version: 1;
  builtinServers?: string[];
  servers: AgentHostConnectorMCPServer[];
}

export interface AgentHostConnectorMCPAuthStatus {
  serverId: string;
  authenticated: boolean;
  expiresAtMs?: number;
  scope?: string;
}

export interface AgentHostConnectorMCPListResult {
  path: string;
  registry: AgentHostConnectorMCPRegistry;
  builtinServers: AgentHostConnectorMCPServer[];
  authStatuses?: Record<string, AgentHostConnectorMCPAuthStatus>;
  registryReadError?: string;
  installResults?: AgentHostConnectorMCPInstallResult[];
  /** Built-in server ids removed on save because no stored OAuth session was available (others still apply). */
  registryPrunedServerIds?: string[];
}

export interface AgentHostConnectorMCPSaveInput {
  registry: AgentHostConnectorMCPRegistry;
}

export interface AgentHostConnectorMCPInstallResult {
  serverId: string;
  status: "ready" | "failed" | "skipped";
  message?: string;
}

export interface AgentHostConnectorSkillSummary {
  name: string;
  path: string;
  content: string;
  source: "builtin" | "user";
}

export interface AgentHostConnectorSkillListResult {
  root: string;
  skills: AgentHostConnectorSkillSummary[];
}
