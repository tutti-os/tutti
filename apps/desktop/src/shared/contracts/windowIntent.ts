import type { DesktopLocale } from "../i18n";
import type { DesktopDockPlacement } from "../preferences/index.ts";
import type {
  DesktopThemeAppearance,
  DesktopThemeSource
} from "../theme/index.ts";
import type { AgentGUIProvider, AgentGUIAgent } from "@tutti-os/agent-gui";
import type { DesktopAgentProviderStatusSnapshot } from "./ipc.ts";
import type {
  DesktopAgentDirectorySnapshot,
  DesktopAgentDirectoryStatus,
  DesktopAgentTargetPresentation
} from "./agentDirectory.ts";

export type DesktopWindowIntent =
  | {
      kind: "workspace";
      workspaceID: string;
    }
  | {
      agentSessionID?: string | null;
      agentTargetID?: string | null;
      agentDirectorySnapshot?: DesktopAgentDirectorySnapshot;
      autoSubmit?: boolean;
      draftPrompt?: string | null;
      providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot;
      kind: "agent";
      provider?: string | null;
      userProjectPath?: string | null;
      workspaceID: string;
    }
  | {
      kind: "workspace-missing";
    };

export interface DesktopWindowIntentSearchOptions {
  dockPlacement?: DesktopDockPlacement;
  locale?: DesktopLocale;
  reportPredefinePageview?: boolean;
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
  agentDirectorySnapshot?: DesktopAgentDirectorySnapshot | null;
  agentSessionID?: string | null;
  agentTargetID?: string | null;
  autoSubmit?: boolean;
  draftPrompt?: string | null;
  providerStatusSnapshot?: DesktopAgentProviderStatusSnapshot | null;
  provider?: string | null;
  userProjectPath?: string | null;
  workspaceID: string;
}): DesktopWindowIntent {
  const agentDirectorySnapshot = normalizeAgentDirectorySnapshot(
    input.agentDirectorySnapshot
  );
  const providerStatusSnapshot = normalizeAgentProviderStatusSnapshot(
    input.providerStatusSnapshot
  );
  return {
    agentSessionID: input.agentSessionID?.trim() || null,
    agentTargetID: input.agentTargetID?.trim() || null,
    ...(agentDirectorySnapshot ? { agentDirectorySnapshot } : {}),
    ...(input.autoSubmit === true ? { autoSubmit: true } : {}),
    ...(input.draftPrompt?.trim()
      ? { draftPrompt: input.draftPrompt.trim() }
      : {}),
    ...(providerStatusSnapshot ? { providerStatusSnapshot } : {}),
    kind: "agent",
    provider: input.provider?.trim() || null,
    ...(input.userProjectPath?.trim()
      ? { userProjectPath: input.userProjectPath.trim() }
      : {}),
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
  if (typeof options.reportPredefinePageview === "boolean") {
    params.set(
      "reportPredefinePageview",
      options.reportPredefinePageview ? "1" : "0"
    );
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
    if (intent.draftPrompt) {
      params.set("draftPrompt", intent.draftPrompt);
    }
    if (intent.autoSubmit) {
      params.set("autoSubmit", "1");
    }
    if (intent.provider) {
      params.set("provider", intent.provider);
    }
    if (intent.userProjectPath) {
      params.set("userProjectPath", intent.userProjectPath);
    }
    if (intent.agentDirectorySnapshot) {
      params.set(
        "agentDirectorySnapshot",
        JSON.stringify(stripDataUrls(intent.agentDirectorySnapshot))
      );
    }
    if (intent.providerStatusSnapshot) {
      params.set(
        "agentProviderStatusSnapshot",
        JSON.stringify(stripDataUrls(intent.providerStatusSnapshot))
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
      agentDirectorySnapshot: parseAgentDirectorySnapshot(
        params.get("agentDirectorySnapshot")
      ),
      agentSessionID: params.get("agentSessionId"),
      agentTargetID: params.get("agentTargetId"),
      autoSubmit: params.get("autoSubmit") === "1",
      draftPrompt: params.get("draftPrompt"),
      providerStatusSnapshot: parseAgentProviderStatusSnapshot(
        params.get("agentProviderStatusSnapshot")
      ),
      provider: params.get("provider"),
      userProjectPath: params.get("userProjectPath"),
      workspaceID
    });
  }

  return createWorkspaceWindowIntent(workspaceID);
}

function parseAgentDirectorySnapshot(
  encodedSnapshot: string | null
): DesktopAgentDirectorySnapshot | undefined {
  if (!encodedSnapshot) {
    return undefined;
  }
  try {
    return normalizeAgentDirectorySnapshot(JSON.parse(encodedSnapshot));
  } catch {
    return undefined;
  }
}

function normalizeAgentDirectorySnapshot(
  value: unknown
): DesktopAgentDirectorySnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const snapshot = value as Partial<DesktopAgentDirectorySnapshot>;
  if (
    !Array.isArray(snapshot.agents) ||
    !Array.isArray(snapshot.agentTargets)
  ) {
    return undefined;
  }
  const status = normalizeAgentDirectoryStatus(snapshot.status);
  const capturedAtUnixMs = normalizeCapturedAtUnixMs(snapshot.capturedAtUnixMs);
  if (!status || capturedAtUnixMs === undefined) {
    return undefined;
  }
  return {
    agents: normalizeAgentWindowAgents(snapshot.agents) ?? [],
    agentTargets: snapshot.agentTargets.flatMap(normalizeAgentTarget),
    capturedAtUnixMs,
    error: readTrimmedString(snapshot.error),
    status
  };
}

function normalizeAgentDirectoryStatus(
  value: unknown
): DesktopAgentDirectoryStatus | null {
  return value === "idle" ||
    value === "loading" ||
    value === "ready" ||
    value === "error"
    ? value
    : null;
}

function normalizeCapturedAtUnixMs(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeAgentTarget(
  value: unknown
): DesktopAgentTargetPresentation[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const target = value as Partial<DesktopAgentTargetPresentation>;
  const agentTargetId = readTrimmedString(target.agentTargetId);
  const name = readTrimmedString(target.name);
  const provider = readTrimmedString(target.provider);
  const launchRefType = readTrimmedString(target.launchRefType);
  const source = readTrimmedString(target.source);
  if (
    !agentTargetId ||
    !name ||
    !provider ||
    !launchRefType ||
    !source ||
    typeof target.enabled !== "boolean" ||
    !isFiniteNumber(target.createdAtUnixMs) ||
    !isFiniteNumber(target.sortOrder) ||
    !isFiniteNumber(target.updatedAtUnixMs)
  ) {
    return [];
  }
  return [
    {
      agentTargetId,
      createdAtUnixMs: target.createdAtUnixMs,
      enabled: target.enabled,
      iconKey: readTrimmedString(target.iconKey),
      iconUrl: typeof target.iconUrl === "string" ? target.iconUrl : "",
      maskIconUrl: readTrimmedString(target.maskIconUrl),
      heroImageUrl: readTrimmedString(target.heroImageUrl),
      availability: readAgentAvailability(target.availability),
      launchRefType:
        launchRefType as DesktopAgentTargetPresentation["launchRefType"],
      name,
      provider: provider as DesktopAgentTargetPresentation["provider"],
      sortOrder: target.sortOrder,
      source: source as DesktopAgentTargetPresentation["source"],
      updatedAtUnixMs: target.updatedAtUnixMs
    }
  ];
}

function readAgentAvailability(value: unknown): AgentGUIAgent["availability"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "unavailable" };
  }
  const availability = value as Partial<AgentGUIAgent["availability"]>;
  const status = readTrimmedString(availability.status);
  if (
    status !== "ready" &&
    status !== "coming_soon" &&
    status !== "not_installed" &&
    status !== "auth_required" &&
    status !== "unavailable"
  ) {
    return { status: "unavailable" };
  }
  return {
    status,
    reason: readTrimmedString(availability.reason),
    pendingAction:
      availability.pendingAction === "install" ||
      availability.pendingAction === "login" ||
      availability.pendingAction === "refresh"
        ? availability.pendingAction
        : null
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  const maskIconUrl = readTrimmedString(agent.maskIconUrl);
  const heroImageUrl = readTrimmedString(agent.heroImageUrl);
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
      ...(maskIconUrl ? { maskIconUrl } : {}),
      ...(description ? { description } : {}),
      ...(heroImageUrl ? { heroImageUrl } : {}),
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

/**
 * Recursively strip `data:` URLs from a value before serializing it into a URL
 * query param.  Extension agent icons (256×256 PNG, ~92 KB → ~123 KB base64)
 * can push a single snapshot past Vite's 16 KB `maxHeaderSize`, producing
 * HTTP 431.  Stripping them keeps agent ids, names, statuses and availability
 * intact so the receiving standalone window still gets a valid bootstrap
 * snapshot — only the visual assets are deferred to the IPC fetch.
 */
function stripDataUrls(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("data:") ? "" : value;
  }
  if (Array.isArray(value)) {
    return value.map(stripDataUrls);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = stripDataUrls(v);
    }
    return result;
  }
  return value;
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
