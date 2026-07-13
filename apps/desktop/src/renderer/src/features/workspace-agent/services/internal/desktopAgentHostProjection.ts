import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
import type { AgentHostAgentSessionComposerSettings as SharedAgentHostAgentSessionComposerSettings } from "@shared/contracts/dto";
import {
  isDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider
} from "../../desktopAgentGUINodeState.ts";

export type AgentHostAgentSessionComposerSettings =
  SharedAgentHostAgentSessionComposerSettings;

export interface AgentHostAgentSessionComposerSettingsInput {
  model?: string | null;
  permissionModeId?: string | null;
  planMode?: boolean | null;
  reasoningEffort?: string | null;
  speed?: string | null;
}

const unsupportedDesktopAgentGUIProviderCode = "agent.provider_unsupported";

export function pathFromFileReadPayload(payload: {
  path?: string;
  uri?: string;
}): string {
  if (payload.path) {
    return payload.path;
  }
  if (payload.uri?.startsWith("file://")) {
    return decodeURIComponent(new URL(payload.uri).pathname);
  }
  return payload.uri ?? "";
}

export function normalizeComposerSettings(
  settings: AgentHostAgentSessionComposerSettingsInput | null | undefined
): AgentHostAgentSessionComposerSettings {
  return {
    model: normalizedOptionalString(settings?.model),
    permissionModeId: resolveComposerPermissionMode(settings),
    planMode: Boolean(settings?.planMode),
    reasoningEffort: normalizedOptionalString(settings?.reasoningEffort),
    speed: normalizedOptionalString(settings?.speed)
  };
}

export function resolveComposerPermissionMode(
  settings: AgentHostAgentSessionComposerSettingsInput | null | undefined
): string | null {
  return normalizedOptionalString(settings?.permissionModeId);
}

export function resolveDesktopAgentGUIProvider(
  provider: string | null | undefined
): DesktopAgentGUIProvider {
  const rawProvider = provider?.trim();
  if (!rawProvider) {
    throw Object.assign(
      new Error("Tutti requires an agent session provider."),
      {
        code: unsupportedDesktopAgentGUIProviderCode,
        debugMessage: "Missing desktop agent provider"
      }
    );
  }
  const normalizedProvider = normalizeDesktopAgentGUIProvider(rawProvider);
  if (isDesktopAgentGUIProvider(rawProvider)) {
    return normalizedProvider;
  }
  throw Object.assign(
    new Error("Tutti does not support this agent session provider."),
    {
      code: unsupportedDesktopAgentGUIProviderCode,
      debugMessage: `Unsupported desktop agent provider: ${rawProvider}`
    }
  );
}

export function agentSessionActivationError(session: AgentActivitySession):
  | {
      code: string;
      debugMessage: string;
      message: string;
    }
  | undefined {
  const message =
    session.activeTurn?.error?.message?.trim() ||
    session.latestTurn?.error?.message?.trim() ||
    null;
  if (
    !message ||
    (session.activeTurn?.error === undefined &&
      session.latestTurn?.outcome !== "failed")
  ) {
    return undefined;
  }
  return {
    code: "agent_session_start_failed",
    debugMessage: message,
    message
  };
}

export function unavailableHostMethod(name: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new Error(`${name} is not available in the Tutti Agent GUI host.`)
    );
}

function normalizedOptionalString(
  value: string | null | undefined
): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
