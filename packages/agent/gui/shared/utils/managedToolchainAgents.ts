import type {
  AgentHostManagedAgentsStateItem,
  AgentHostManagedAgentsState
} from "../contracts/dto";
import type { AgentProvider } from "../../contexts/settings/domain/agentSettings";
import { resolveMigratedAgentGUIProviderIdentity } from "../../providerIdentityCatalog.ts";

export type AgentHostManagedToolchainAgent = {
  id: string;
  label: string;
  actionAgentId?: string;
  toolIds: string[];
  agentIds: string[];
  runtimeManaged: boolean;
  helperProvider?:
    | "codex"
    | "claude"
    | "cursor"
    | "openclaw"
    | "opencode"
    | "nexight"
    | "hermes";
  aliases?: string[];
};

export type AgentHostManagedToolchainActionKind =
  | "installed"
  | "sync"
  | "install";

export const AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS: readonly AgentHostManagedToolchainAgent[] =
  [
    {
      id: "claude-code",
      // i18n-check-ignore: Provider brand name.
      label: "Claude Code",
      toolIds: ["claude-code-cli"],
      agentIds: ["claude-code"],
      runtimeManaged: true,
      helperProvider: "claude",
      aliases: ["claude code", "claude"]
    },
    {
      id: "codex",
      label: migratedProviderDisplayName("codex"),
      toolIds: ["codex-cli"],
      agentIds: ["codex"],
      runtimeManaged: true,
      helperProvider: "codex"
    },
    {
      id: "cursor",
      // i18n-check-ignore: Provider brand name.
      label: "Cursor",
      toolIds: ["cursor-cli"],
      agentIds: ["cursor"],
      runtimeManaged: true,
      helperProvider: "cursor",
      aliases: ["cursor cli", "cursor agent", "cursor-agent"]
    },
    {
      id: "tutti",
      // i18n-check-ignore: Provider brand name.
      label: "Tutti",
      actionAgentId: "nexight",
      toolIds: ["nexight-cli"],
      agentIds: ["nexight", "tutti"],
      runtimeManaged: false,
      helperProvider: "nexight"
    },
    {
      id: "hermes",
      // i18n-check-ignore: Provider brand name.
      label: "Hermes",
      toolIds: ["hermes-cli"],
      agentIds: ["hermes"],
      runtimeManaged: true,
      helperProvider: "hermes",
      aliases: ["hermes agent"]
    },
    {
      id: "openclaw",
      // i18n-check-ignore: Provider brand name.
      label: "OpenClaw",
      toolIds: ["openclaw-cli"],
      agentIds: ["openclaw"],
      runtimeManaged: true,
      helperProvider: "openclaw",
      aliases: ["open claw"]
    },
    {
      id: "opencode",
      label: migratedProviderDisplayName("opencode"),
      toolIds: ["opencode-cli"],
      agentIds: ["opencode"],
      runtimeManaged: true,
      helperProvider: "opencode",
      aliases: migratedProviderAliases("opencode")
    }
  ] as const;

function migratedProviderDisplayName(providerId: string): string {
  const identity = resolveMigratedAgentGUIProviderIdentity(providerId);
  if (!identity) {
    throw new Error(`Missing migrated provider identity for ${providerId}`);
  }
  return identity.displayName;
}

function migratedProviderAliases(providerId: string): string[] {
  const identity = resolveMigratedAgentGUIProviderIdentity(providerId);
  if (!identity) {
    throw new Error(`Missing migrated provider identity for ${providerId}`);
  }
  return [...identity.aliases];
}

/**
 * Workspace Dock 中托管 Agent 图标顺序，与 Manage Agents 页面列表（`AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS`）一致。
 */
export const WORKSPACE_DESKTOP_MANAGED_AGENT_DOCK_PROVIDER_ORDER: readonly AgentProvider[] =
  AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS.map((agent) =>
    agent.id === "tutti" ? "tutti-agent" : (agent.id as AgentProvider)
  );

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function hasAnyAgentState(
  stateAgentIds: Set<string>,
  agent: AgentHostManagedToolchainAgent
): boolean {
  return agent.agentIds.some((candidate) =>
    stateAgentIds.has(normalizeKey(candidate))
  );
}

function hasHostConfig(
  item: AgentHostManagedAgentsStateItem | undefined
): boolean {
  return Boolean(item?.hostConfigDetected);
}

export function findAgentHostManagedAgentsStateItemIndex(
  agent: AgentHostManagedToolchainAgent,
  managedAgentsState: AgentHostManagedAgentsState | null
): number {
  if (!managedAgentsState) {
    return -1;
  }

  return managedAgentsState.items.findIndex((item) => {
    const toolId = normalizeKey(item.toolId);
    const agentId = normalizeKey(item.agentId);
    return (
      agent.toolIds.some((candidate) => normalizeKey(candidate) === toolId) ||
      agent.agentIds.some((candidate) => normalizeKey(candidate) === agentId)
    );
  });
}

/** Managed toolchain agent action used by runtime/home projections. */
export function resolveAgentHostManagedToolchainAgentAction(
  agent: AgentHostManagedToolchainAgent,
  managedAgentsState: AgentHostManagedAgentsState | null
): AgentHostManagedToolchainActionKind {
  const stateItemIndex = findAgentHostManagedAgentsStateItemIndex(
    agent,
    managedAgentsState
  );
  const pendingStateItem =
    stateItemIndex >= 0 ? managedAgentsState?.items[stateItemIndex] : undefined;
  return resolveAgentHostManagedToolchainAction(
    agent,
    pendingStateItem,
    managedAgentsState
  );
}

export function resolveAgentHostManagedToolchainAction(
  agent: AgentHostManagedToolchainAgent,
  pendingStateItem: AgentHostManagedAgentsStateItem | undefined,
  managedAgentsState: AgentHostManagedAgentsState | null
): AgentHostManagedToolchainActionKind {
  // Managed Agents show Installed only when the agent is ready for AgentGUI use.
  if (!managedAgentsState) {
    return "install";
  }

  const readyAgentIds = new Set(
    (managedAgentsState.readyAgentIds ?? []).map(normalizeKey)
  );
  if (agent.id === "openclaw") {
    if (readyAgentIds.has("openclaw")) {
      return "installed";
    }

    return hasHostConfig(pendingStateItem) ? "sync" : "install";
  }

  if (hasAnyAgentState(readyAgentIds, agent)) {
    return "installed";
  }

  if (pendingStateItem) {
    return hasHostConfig(pendingStateItem) ? "sync" : "install";
  }

  return "install";
}

export function getAgentHostManagedToolchainAgentByName(
  name: string
): AgentHostManagedToolchainAgent | null {
  const normalized = normalizeKey(name);
  if (!normalized) {
    return null;
  }

  return (
    AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS.find((agent) =>
      [
        agent.id,
        agent.label,
        agent.actionAgentId,
        ...agent.agentIds,
        ...(agent.aliases ?? [])
      ].some((candidate) => normalizeKey(candidate) === normalized)
    ) ?? null
  );
}
