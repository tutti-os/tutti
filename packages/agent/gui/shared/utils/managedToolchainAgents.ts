import type {
  AgentHostManagedAgentsStateItem,
  AgentHostManagedAgentsState
} from "../contracts/dto";
import type { AgentProvider } from "../../contexts/settings/domain/agentSettings";

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
    | "gemini"
    | "openclaw"
    | "nexight"
    | "hermes"
    | "antigravity";
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
      // i18n-check-ignore: Provider brand name.
      label: "Codex",
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
      id: "gemini",
      // i18n-check-ignore: Provider brand name.
      label: "Gemini CLI",
      toolIds: ["gemini-cli"],
      agentIds: ["gemini"],
      runtimeManaged: true,
      helperProvider: "gemini",
      aliases: ["gemini cli"]
    },
    {
      id: "antigravity",
      // i18n-check-ignore: Provider brand name.
      label: "Antigravity",
      toolIds: ["antigravity-cli"],
      agentIds: ["antigravity"],
      runtimeManaged: true,
      helperProvider: "antigravity",
      aliases: ["antigravity", "antigravity cli", "agy"]
    }
  ] as const;

/**
 * Workspace Dock 中托管 Agent 图标顺序，与 Manage Agents 页面列表（`AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS`）一致。
 */
export const WORKSPACE_DESKTOP_MANAGED_AGENT_DOCK_PROVIDER_ORDER: readonly AgentProvider[] =
  AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS.map((agent) =>
    agent.id === "tutti" ? "nexight" : (agent.id as AgentProvider)
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

export function getAgentHostManagedToolchainAgentActionAgentId(
  agent: AgentHostManagedToolchainAgent
): string {
  return agent.actionAgentId ?? agent.id;
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

export function resolveAgentHostManagedAgentsStateItem(
  agent: AgentHostManagedToolchainAgent,
  managedAgentsState: AgentHostManagedAgentsState | null
): AgentHostManagedAgentsStateItem | undefined {
  const stateItemIndex = findAgentHostManagedAgentsStateItemIndex(
    agent,
    managedAgentsState
  );
  return stateItemIndex >= 0
    ? managedAgentsState?.items[stateItemIndex]
    : undefined;
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

/** 与 Manage Agents 中标记为 Installed 的行数一致（最多为托管 agents 种类数）。 */
export function countAgentHostInstalledManagedAgents(
  managedAgentsState: AgentHostManagedAgentsState | null
): number {
  let installed = 0;
  for (const agent of AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS) {
    if (
      resolveAgentHostManagedToolchainAgentAction(agent, managedAgentsState) ===
      "installed"
    ) {
      installed++;
    }
  }
  return installed;
}

/** Host-side config was synced into the VM for this managed agent (see managedAgentsState.configSyncedAgentIds). */
export function isAgentHostManagedAgentHostConfigSynced(
  agent: AgentHostManagedToolchainAgent,
  managedAgentsState: AgentHostManagedAgentsState | null
): boolean {
  const ids = managedAgentsState?.configSyncedAgentIds;
  if (!ids?.length) {
    return false;
  }
  const synced = new Set(ids.map(normalizeKey));
  const actionId = normalizeKey(
    getAgentHostManagedToolchainAgentActionAgentId(agent)
  );
  if (synced.has(actionId)) {
    return true;
  }
  return agent.agentIds.some((id) => synced.has(normalizeKey(id)));
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

export function getAgentHostManagedToolchainAgentById(
  id: string
): AgentHostManagedToolchainAgent | null {
  const normalized = normalizeKey(id);
  return (
    AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS.find(
      (agent) => normalizeKey(agent.id) === normalized
    ) ?? null
  );
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

export function listAgentHostGameManagedToolchainAgents(): readonly AgentHostManagedToolchainAgent[] {
  return AGENT_HOST_MANAGED_TOOLCHAIN_AGENTS.filter(
    (agent) => !!agent.helperProvider
  );
}
