import type { DesktopLocale } from "../i18n";
import type { DesktopDockPlacement } from "../preferences/index.ts";
import type {
  DesktopThemeAppearance,
  DesktopThemeSource
} from "../theme/index.ts";
import type {
  AgentGUIProvider,
  AgentGUIProviderTarget,
  AgentGUIProviderTargetRef
} from "@tutti-os/agent-gui";
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
      providerTargets?: readonly AgentGUIProviderTarget[];
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
  providerTargets?: readonly AgentGUIProviderTarget[];
  provider?: string | null;
  workspaceID: string;
}): DesktopWindowIntent {
  const providerTargets = normalizeAgentWindowProviderTargets(
    input.providerTargets
  );
  const providerStatusSnapshot = normalizeAgentProviderStatusSnapshot(
    input.providerStatusSnapshot
  );
  return {
    agentSessionID: input.agentSessionID?.trim() || null,
    agentTargetID: input.agentTargetID?.trim() || null,
    ...(providerStatusSnapshot ? { providerStatusSnapshot } : {}),
    ...(providerTargets ? { providerTargets } : {}),
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
    if (intent.providerTargets && intent.providerTargets.length > 0) {
      params.set(
        "agentProviderTargets",
        JSON.stringify(intent.providerTargets)
      );
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
      providerTargets: parseAgentWindowProviderTargets(
        params.get("agentProviderTargets")
      ),
      provider: params.get("provider"),
      workspaceID
    });
  }

  return createWorkspaceWindowIntent(workspaceID);
}

function normalizeAgentWindowProviderTargets(
  providerTargets: readonly AgentGUIProviderTarget[] | null | undefined
): AgentGUIProviderTarget[] | undefined {
  const normalized =
    providerTargets?.flatMap((target) =>
      normalizeAgentWindowProviderTarget(target)
    ) ?? [];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAgentWindowProviderTarget(
  value: unknown
): AgentGUIProviderTarget[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const target = value as Partial<AgentGUIProviderTarget>;
  if (!target.ref || typeof target.ref !== "object") {
    return [];
  }
  const ref = target.ref as Partial<AgentGUIProviderTargetRef>;
  const targetId = readTrimmedString(target.targetId);
  const agentTargetId = readTrimmedString(target.agentTargetId);
  const description = readTrimmedString(target.description);
  const iconUrl = readTrimmedString(target.iconUrl);
  const label = readTrimmedString(target.label);
  const ownerLabel = readTrimmedString(target.ownerLabel);
  const provider = readTrimmedString(
    target.provider
  ) as AgentGUIProvider | null;
  const refKind = readTrimmedString(ref.kind);
  const refProvider = readTrimmedString(ref.provider);
  const unavailableReason = readTrimmedString(target.unavailableReason);
  if (
    !targetId ||
    !label ||
    !provider ||
    !refKind ||
    refProvider !== provider
  ) {
    return [];
  }

  return [
    {
      targetId,
      ...(agentTargetId ? { agentTargetId } : {}),
      provider,
      ref: {
        ...ref,
        kind: refKind,
        provider
      } as AgentGUIProviderTargetRef,
      label,
      ...(description ? { description } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(ownerLabel ? { ownerLabel } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(typeof target.disabled === "boolean"
        ? { disabled: target.disabled }
        : {})
    }
  ];
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAgentWindowProviderTargets(
  value: string | null
): AgentGUIProviderTarget[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return normalizeAgentWindowProviderTargets(
      parsed as readonly AgentGUIProviderTarget[]
    );
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
