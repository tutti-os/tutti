import type { ScopedSessionResultValidation } from "./commandResult.validation.ts";
import type { PendingActivationIntentRecord } from "./pendingIntents.types.ts";
import type { SessionSettingsActivationRequestedIntent } from "./sessionLifecycle.types.ts";
import type { EngineCommandResultIntent } from "./types.ts";

export function attachPendingActivationSettings(
  record: PendingActivationIntentRecord
): {
  followUpIntents: readonly SessionSettingsActivationRequestedIntent[];
  record: PendingActivationIntentRecord;
} {
  const settings = record.pendingSettingsPatch;
  if (
    !settings ||
    Object.keys(settings).length === 0 ||
    record.settingsUpdateStatus === "inFlight"
  ) {
    return { followUpIntents: [], record };
  }
  return {
    followUpIntents: [
      {
        agentSessionId: record.agentSessionId,
        commandId: `activation-settings:${record.requestId}`,
        settings: { ...settings },
        type: "session/settingsActivationRequested",
        workspaceId: record.workspaceId
      }
    ],
    record: { ...record, settingsUpdateStatus: "inFlight" }
  };
}

export function settlePendingActivationSettings(
  recordsByRequestId: Readonly<Record<string, PendingActivationIntentRecord>>,
  intent: EngineCommandResultIntent,
  validation: ScopedSessionResultValidation | null
): PendingActivationIntentRecord | null {
  const agentSessionId = intent.correlationId?.trim() ?? "";
  const record = Object.values(recordsByRequestId).find(
    (candidate) =>
      candidate.agentSessionId === agentSessionId &&
      candidate.settingsUpdateStatus === "inFlight" &&
      intent.commandId === `activation-settings:${candidate.requestId}`
  );
  if (!record) return null;
  if (intent.outcome === "succeeded" && validation?.kind === "valid") {
    const {
      pendingSettingsPatch: _patch,
      settingsUpdateStatus: _status,
      ...next
    } = record;
    return next;
  }
  return {
    ...record,
    errorCode:
      intent.outcome === "succeeded"
        ? "invalid_command_result"
        : intent.errorCode?.trim() || "settings_update_failed",
    errorMessage: intent.errorMessage?.trim() || null,
    settingsUpdateStatus:
      intent.outcome === "timedOut" || intent.outcome === "succeeded"
        ? "unknown"
        : "failed"
  };
}
