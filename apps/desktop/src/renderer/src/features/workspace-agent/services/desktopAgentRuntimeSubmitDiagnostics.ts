import type { DesktopRuntimeApi } from "@preload/types";
import type { AgentActivitySubmitDiagnostics } from "@tutti-os/agent-activity-core";
import {
  resolveComposerPermissionMode,
  resolveDesktopAgentGUIProvider,
  type AgentHostAgentSessionComposerSettings
} from "./internal/desktopAgentHostProjection.ts";

type AgentComposerSettingsChange = {
  field: "model" | "permissionModeId" | "planMode" | "reasoningEffort";
  from: boolean | string | null;
  to: boolean | string | null;
};

export function reportAgentSubmitTraceDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic"> | undefined,
  input: {
    agentSessionId: string | null;
    clientSubmitId: string | null | undefined;
    event: string;
    submitDiagnostics: AgentActivitySubmitDiagnostics | undefined;
    workspaceId: string;
    provider?: string | null;
    fields?: Record<string, unknown>;
  }
): void {
  if (!runtimeApi) {
    return;
  }
  const clientSubmitId = input.clientSubmitId?.trim() ?? "";
  if (!clientSubmitId) {
    return;
  }
  const submittedAtUnixMs = input.submitDiagnostics?.submittedAtUnixMs ?? 0;
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details: {
          agentSessionId: input.agentSessionId,
          clientSubmitId,
          clientSubmittedAtUnixMs: submittedAtUnixMs,
          elapsedSinceClientSubmitMs:
            submittedAtUnixMs > 0
              ? Math.max(0, Date.now() - submittedAtUnixMs)
              : null,
          provider: input.provider ?? null,
          traceEvent: input.event,
          ...(input.fields ?? {})
        },
        event: "agent.submit.trace",
        level: "info",
        workspaceId: input.workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect agent submission.
  }
}

export function promptContentDisplayText(
  content: readonly { type: string; text?: string }[]
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

export function logAgentComposerSettingsDiagnostic(input: {
  agentSessionId: string | null;
  error?: unknown;
  event:
    | "agent.gui.composer_settings.changed"
    | "agent.gui.composer_settings.update_requested"
    | "agent.gui.composer_settings.update_failed";
  nextSettings: AgentHostAgentSessionComposerSettings;
  previousSettings: AgentHostAgentSessionComposerSettings | undefined;
  provider: string;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  source: "draft" | "session";
  workspaceId: string;
}): void {
  if (!input.runtimeApi) {
    return;
  }
  const changes = agentComposerSettingsChanges(
    input.previousSettings,
    input.nextSettings
  );
  if (
    changes.length === 0 &&
    input.event === "agent.gui.composer_settings.changed"
  ) {
    return;
  }
  void input.runtimeApi.logTerminalDiagnostic({
    details: {
      agentSessionId: input.agentSessionId,
      changedFields: changes.map((change) => change.field).join(","),
      ...(input.error ? { error: stringifyDiagnosticError(input.error) } : {}),
      ...flattenAgentComposerSettingsChanges(changes),
      provider: resolveDesktopAgentGUIProvider(input.provider),
      source: input.source
    },
    event: input.event,
    level: input.error ? "warn" : "info",
    sessionId: input.agentSessionId ?? undefined,
    workspaceId: input.workspaceId
  });
}

export function agentComposerSettingsChanges(
  previousSettings: AgentHostAgentSessionComposerSettings | undefined,
  nextSettings: AgentHostAgentSessionComposerSettings
): AgentComposerSettingsChange[] {
  const previousPermissionMode =
    resolveComposerPermissionMode(previousSettings);
  const nextPermissionMode = resolveComposerPermissionMode(nextSettings);
  const changes: AgentComposerSettingsChange[] = [];
  for (const change of [
    stringSettingChange("model", previousSettings?.model, nextSettings.model),
    stringSettingChange(
      "permissionModeId",
      previousPermissionMode,
      nextPermissionMode
    ),
    booleanSettingChange(
      "planMode",
      previousSettings?.planMode,
      nextSettings.planMode
    ),
    stringSettingChange(
      "reasoningEffort",
      previousSettings?.reasoningEffort,
      nextSettings.reasoningEffort
    )
  ]) {
    if (change) {
      changes.push(change);
    }
  }
  return changes;
}

export function stringSettingChange(
  field: "model" | "permissionModeId" | "reasoningEffort",
  previousValue: string | null | undefined,
  nextValue: string | null | undefined
): { field: typeof field; from: string | null; to: string | null } | null {
  const from = normalizedOptionalSetting(previousValue);
  const to = normalizedOptionalSetting(nextValue);
  return from === to ? null : { field, from, to };
}

export function booleanSettingChange(
  field: "planMode",
  previousValue: boolean | null | undefined,
  nextValue: boolean | null | undefined
): { field: typeof field; from: boolean | null; to: boolean | null } | null {
  const from = previousValue ?? null;
  const to = nextValue ?? null;
  return from === to ? null : { field, from, to };
}

export function normalizedOptionalSetting(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function flattenAgentComposerSettingsChanges(
  changes: AgentComposerSettingsChange[]
): Record<string, boolean | string | null> {
  const details: Record<string, boolean | string | null> = {};
  for (const change of changes) {
    details[`${change.field}From`] = change.from;
    details[`${change.field}To`] = change.to;
  }
  return details;
}

export function uint8ArrayToBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < value.length; index += chunkSize) {
    const chunk = value.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

export function stringifyDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
