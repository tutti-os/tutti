import type {
  AgentLiveAttachmentControl,
  AgentLiveDelivery,
  AgentLiveReconcileKey
} from "../services/servicePorts";

export function parseAgentLiveDeliveries(
  workspaceId: string,
  subscriptionGeneration: number,
  payload: string
): AgentLiveDelivery[] {
  try {
    const envelope = JSON.parse(payload) as {
      reason?: unknown;
      result?: {
        accepted?: unknown;
        reason?: unknown;
        reconcileRequired?: unknown;
      };
      status?: unknown;
      subscriptionGeneration?: unknown;
      workspaceId?: unknown;
    };
    if (
      envelope.workspaceId !== workspaceId ||
      envelope.subscriptionGeneration !== subscriptionGeneration
    ) {
      return [];
    }
    if (envelope.status === "disconnected") {
      return [
        {
          kind: "connection",
          reason:
            typeof envelope.reason === "string"
              ? envelope.reason
              : "stream_closed",
          retryable: true,
          status: "disconnected"
        }
      ];
    }
    const result = envelope.result;
    if (!result || !Array.isArray(result.accepted)) return [];
    const deliveries: AgentLiveDelivery[] = [];
    let hasDiscontinuity = false;
    for (const accepted of result.accepted) {
      if (!isRecord(accepted)) continue;
      if (accepted.kind === "stream_ready") {
        deliveries.push({ kind: "connection", status: "connected" });
        continue;
      }
      if (accepted.kind === "event" && isRecord(accepted.event)) {
        deliveries.push({
          event: accepted.event as unknown as Extract<
            AgentLiveDelivery,
            { kind: "event" }
          >["event"],
          kind: "event"
        });
        continue;
      }
      if (accepted.kind === "discontinuity") {
        const discontinuity = isRecord(accepted.discontinuity)
          ? accepted.discontinuity
          : {};
        const reason =
          typeof discontinuity.reason === "string"
            ? discontinuity.reason
            : "stream_discontinuity";
        const reconcileKeys = parseReconcileKeys(discontinuity.reconcileKeys);
        hasDiscontinuity = true;
        const lifecycleKind =
          reason === "session_deleted" || reason === "session_restored"
            ? reason
            : null;
        const lifecycleSessionId = lifecycleKind
          ? lifecycleSessionIdFromReconcileKeys(workspaceId, reconcileKeys)
          : null;
        if (lifecycleKind && lifecycleSessionId) {
          deliveries.push({
            agentSessionId: lifecycleSessionId,
            kind: lifecycleKind
          });
          continue;
        }
        deliveries.push({
          kind: "discontinuity",
          reason,
          reconcileKeys
        });
        continue;
      }
      if (accepted.kind === "rejected") {
        const rejected = isRecord(accepted.rejected) ? accepted.rejected : {};
        deliveries.push({
          ...(typeof rejected.expectedRevision === "string"
            ? { expectedRevision: rejected.expectedRevision }
            : {}),
          kind: "connection",
          reason:
            typeof rejected.reason === "string"
              ? rejected.reason
              : "stream_rejected",
          ...(typeof rejected.receivedRevision === "string"
            ? { receivedRevision: rejected.receivedRevision }
            : {}),
          retryable: false,
          status: "disconnected"
        });
        continue;
      }
      if (
        accepted.kind === "attachment_changed" ||
        accepted.kind === "attachment_caught_up"
      ) {
        const attachment = parseAttachmentControl(
          accepted[
            accepted.kind === "attachment_changed"
              ? "attachmentChanged"
              : "attachmentCaughtUp"
          ]
        );
        if (!attachment) {
          deliveries.push({
            kind: "discontinuity",
            reason: "invalid_attachment_control",
            reconcileKeys: []
          });
          continue;
        }
        deliveries.push({
          attachment,
          kind: accepted.kind
        });
        continue;
      }
      deliveries.push({
        kind: "discontinuity",
        reason:
          accepted.kind === "goal_changed" ? accepted.kind : "unknown_delivery",
        reconcileKeys: []
      });
    }
    if (result.reconcileRequired === true && !hasDiscontinuity) {
      deliveries.push({
        kind: "discontinuity",
        reason:
          typeof result.reason === "string"
            ? result.reason
            : "stream_discontinuity",
        reconcileKeys: []
      });
    }
    return deliveries;
  } catch {
    return [
      {
        kind: "discontinuity",
        reason: "invalid_native_delivery",
        reconcileKeys: []
      }
    ];
  }
}

function parseAttachmentControl(
  value: unknown
): AgentLiveAttachmentControl | null {
  if (!isRecord(value)) return null;
  const bindingId = nonEmptyString(value.bindingId);
  const workspaceId = nonEmptyString(value.workspaceId);
  const agentSessionId = nonEmptyString(value.agentSessionId);
  const canonicalTurnId = optionalNonEmptyString(value.canonicalTurnId);
  const callerTurnId = optionalNonEmptyString(value.callerTurnId);
  if (
    !bindingId ||
    !workspaceId ||
    !agentSessionId ||
    !Number.isSafeInteger(value.attachmentRevision) ||
    (value.attachmentRevision as number) <= 0 ||
    canonicalTurnId === null ||
    callerTurnId === null ||
    Boolean(canonicalTurnId) !== Boolean(callerTurnId)
  ) {
    return null;
  }
  return {
    agentSessionId,
    attachmentRevision: value.attachmentRevision as number,
    bindingId,
    workspaceId,
    ...(callerTurnId ? { callerTurnId } : {}),
    ...(canonicalTurnId ? { canonicalTurnId } : {})
  };
}

function parseReconcileKeys(value: unknown): AgentLiveReconcileKey[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.kind !== "string" ||
      typeof candidate.workspaceId !== "string"
    ) {
      return [];
    }
    return [
      {
        kind: candidate.kind,
        workspaceId: candidate.workspaceId,
        ...(typeof candidate.agentSessionId === "string"
          ? { agentSessionId: candidate.agentSessionId }
          : {}),
        ...(typeof candidate.messageId === "string"
          ? { messageId: candidate.messageId }
          : {}),
        ...(typeof candidate.turnId === "string"
          ? { turnId: candidate.turnId }
          : {}),
        ...(typeof candidate.requestId === "string"
          ? { requestId: candidate.requestId }
          : {})
      }
    ];
  });
}

function lifecycleSessionIdFromReconcileKeys(
  workspaceId: string,
  reconcileKeys: readonly AgentLiveReconcileKey[]
): string | null {
  if (reconcileKeys.length !== 1) return null;
  const [key] = reconcileKeys;
  if (key.kind !== "session" || key.workspaceId !== workspaceId) return null;
  return nonEmptyString(key.agentSessionId);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function optionalNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
