import type { DesktopLocale } from "../i18n";
import type { DesktopDockPlacement } from "../preferences/index.ts";
import type {
  DesktopThemeAppearance,
  DesktopThemeSource
} from "../theme/index.ts";
import type { AgentGUIProvider, AgentGUIAgent } from "@tutti-os/agent-gui";
import type { DesktopAgentProviderStatusSnapshot } from "./ipc.ts";

export type DesktopWindowIntent =
  | {
      kind: "workspace";
      workspaceID: string;
    }
  | {
      agentSessionID?: string | null;
      agentTargetID?: string | null;
      providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot;
      agents?: readonly AgentGUIAgent[];
      kind: "agent";
      provider?: string | null;
      workspaceID: string;
    }
  | {
      kind: "workspace-missing";
    };

export interface DesktopWindowIntentSearchOptions {
  dockPlacement?: DesktopDockPlacement;
  locale?: DesktopLocale;
  themeAppearance?: DesktopThemeAppearance;
  themeSource?: DesktopThemeSource;
}

export function createWorkspaceWindowIntent(
  workspaceID: string
): DesktopWindowIntent {
  return {
    kind: "workspace",
    workspaceID
  };
}

export function createAgentWindowIntent(input: {
  agentSessionID?: string | null;
  agentTargetID?: string | null;
  providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot | null;
  agents?: readonly AgentGUIAgent[];
  provider?: string | null;
  workspaceID: string;
}): DesktopWindowIntent {
  const agents = normalizeAgentWindowAgents(input.agents);
  const providerStatusSnapshot = normalizeAgentProviderStatusSnapshot(
    input.providerStatusSnapshot
  );
  return {
    agentSessionID: input.agentSessionID?.trim() || null,
    agentTargetID: input.agentTargetID?.trim() || null,
    ...(providerStatusSnapshot ? { providerStatusSnapshot } : {}),
    ...(agents !== undefined ? { agents } : {}),
    kind: "agent",
    provider: input.provider?.trim() || null,
    workspaceID: input.workspaceID
  };
}

export function encodeDesktopWindowIntent(
  intent: DesktopWindowIntent,
  options: DesktopWindowIntentSearchOptions = {}
): string {
  const params = new URLSearchParams();

  if (options.locale) {
    params.set("lang", options.locale);
  }
  if (options.dockPlacement) {
    params.set("dockPlacement", options.dockPlacement);
  }
  if (options.themeSource) {
    params.set("themeSource", options.themeSource);
  }
  if (options.themeAppearance) {
    params.set("theme", options.themeAppearance);
  }

  if (intent.kind === "agent") {
    params.set("view", "agent");
    params.set("workspaceId", intent.workspaceID);
    if (intent.agentSessionID) {
      params.set("agentSessionId", intent.agentSessionID);
    }
    if (intent.agentTargetID) {
      params.set("agentTargetId", intent.agentTargetID);
    }
    if (intent.provider) {
      params.set("provider", intent.provider);
    }
    if (intent.agents !== undefined) {
      params.set("agents", JSON.stringify(intent.agents));
    }
    if (intent.providerStatusSnapshot) {
      params.set(
        "agentProviderStatusSnapshot",
        JSON.stringify(intent.providerStatusSnapshot)
      );
    }
  } else {
    params.set("view", "workspace");
    if (intent.kind === "workspace") {
      params.set("workspaceId", intent.workspaceID);
    }
  }

  return params.toString();
}

export function applyDesktopWindowIntent(
  baseUrl: string,
  intent: DesktopWindowIntent,
  options: DesktopWindowIntentSearchOptions = {}
): string {
  const url = new URL(baseUrl);
  url.search = encodeDesktopWindowIntent(intent, options);
  return url.toString();
}

export function resolveDesktopWindowIntent(
  search: string
): DesktopWindowIntent {
  const params = new URLSearchParams(search);
  const view = params.get("view");

  if (view !== "workspace" && view !== "agent") {
    return {
      kind: "workspace-missing"
    };
  }

  const workspaceID = params.get("workspaceId")?.trim();
  if (!workspaceID) {
    return {
      kind: "workspace-missing"
    };
  }

  if (view === "agent") {
    return createAgentWindowIntent({
      agentSessionID: params.get("agentSessionId"),
      agentTargetID: params.get("agentTargetId"),
      providerStatusSnapshot: parseAgentProviderStatusSnapshot(
        params.get("agentProviderStatusSnapshot")
      ),
      agents: parseAgentWindowAgents(params.get("agents")),
      provider: params.get("provider"),
      workspaceID
    });
  }

  return createWorkspaceWindowIntent(workspaceID);
}

function normalizeAgentWindowAgents(
  agents: readonly AgentGUIAgent[] | null | undefined
): AgentGUIAgent[] | undefined {
  if (agents === null || agents === undefined) {
    return undefined;
  }
  return agents.flatMap((agent) => normalizeAgentWindowAgent(agent));
}

function normalizeAgentWindowAgent(value: unknown): AgentGUIAgent[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const agent = value as Partial<AgentGUIAgent>;
  const agentTargetId = readTrimmedString(agent.agentTargetId);
  const name = readTrimmedString(agent.name);
  const description = readTrimmedString(agent.description);
  const iconUrl = readTrimmedString(agent.iconUrl);
  const provider = readTrimmedString(agent.provider) as AgentGUIProvider | null;
  const availability = normalizeAgentWindowAvailability(agent.availability);
  if (!agentTargetId || !name || !iconUrl || !provider || !availability) {
    return [];
  }

  const ownerName = readTrimmedString(agent.owner?.name);
  const ownerAvatarUrl = readTrimmedString(agent.owner?.avatarUrl);

  return [
    {
      agentTargetId,
      name,
      iconUrl,
      provider,
      availability,
      ...(description ? { description } : {}),
      ...(ownerName || ownerAvatarUrl
        ? {
            owner: {
              ...(ownerName ? { name: ownerName } : {}),
              ...(ownerAvatarUrl ? { avatarUrl: ownerAvatarUrl } : {})
            }
          }
        : {})
    }
  ];
}

function normalizeAgentWindowAvailability(
  value: unknown
): AgentGUIAgent["availability"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const availability = value as Partial<AgentGUIAgent["availability"]>;
  const status = availability.status;
  if (
    status !== "ready" &&
    status !== "checking" &&
    status !== "coming_soon" &&
    status !== "not_installed" &&
    status !== "auth_required" &&
    status !== "unavailable"
  ) {
    return null;
  }
  const reason = readTrimmedString(availability.reason);
  const pendingAction = availability.pendingAction;
  return {
    status,
    ...(reason ? { reason } : {}),
    ...(pendingAction === "install" ||
    pendingAction === "login" ||
    pendingAction === "refresh"
      ? { pendingAction }
      : {})
  };
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAgentWindowAgents(
  value: string | null
): AgentGUIAgent[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return normalizeAgentWindowAgents(parsed as readonly AgentGUIAgent[]);
  } catch {
    return undefined;
  }
}

function parseAgentProviderStatusSnapshot(
  value: string | null
): DesktopAgentProviderStatusSnapshot | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return normalizeAgentProviderStatusSnapshot(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizeAgentProviderStatusSnapshot(
  value: unknown
): DesktopAgentProviderStatusSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const snapshot = value as Partial<DesktopAgentProviderStatusSnapshot>;
  const capturedAt = readOptionalString(snapshot.capturedAt);
  if (!capturedAt) {
    return undefined;
  }
  return {
    capturedAt,
    defaultProvider: readOptionalString(
      snapshot.defaultProvider
    ) as DesktopAgentProviderStatusSnapshot["defaultProvider"],
    error: readOptionalString(snapshot.error),
    isLoading: snapshot.isLoading === true,
    pendingActions: Array.isArray(snapshot.pendingActions)
      ? snapshot.pendingActions
      : [],
    statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses : []
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
