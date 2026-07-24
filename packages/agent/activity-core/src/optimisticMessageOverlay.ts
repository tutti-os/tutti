import { cloneJSONValue } from "./activityValueParsing.ts";
import type {
  AgentActivityLiveEvent,
  AgentActivityMessageDeltaEvent
} from "./liveEvent.types.ts";
import {
  compareAgentActivityMessages,
  mergeAgentActivityMessages
} from "./merge.ts";
import type {
  AgentActivityMessage,
  AgentActivityMessageSemantics
} from "./types.ts";

export interface AgentActivityOptimisticApplyResult {
  applied: boolean;
  needsReconcile: boolean;
  reason?: "append_without_anchor" | "identity_mismatch";
}

export interface AgentActivityOptimisticMessageOverlay {
  apply(event: AgentActivityLiveEvent): AgentActivityOptimisticApplyResult;
  reconcile(canonicalMessages: readonly AgentActivityMessage[]): void;
  clearSession(workspaceId: string, agentSessionId: string): void;
  project(
    canonicalMessages: readonly AgentActivityMessage[]
  ): AgentActivityMessage[];
}

interface OptimisticEntry {
  message: AgentActivityMessage;
  payloadUnset: ReadonlySet<string>;
}

export function createAgentActivityOptimisticMessageOverlay(): AgentActivityOptimisticMessageOverlay {
  const optimistic = new Map<string, OptimisticEntry>();
  const canonical = new Map<string, AgentActivityMessage>();

  return {
    apply(event) {
      if (event.eventType !== "message_delta") {
        return { applied: false, needsReconcile: false };
      }
      return applyMessageDelta(event);
    },

    reconcile(messages) {
      canonical.clear();
      for (const message of messages) {
        const key = messageKey(message);
        canonical.set(key, cloneMessage(message));
        if (isTerminalMessage(message)) {
          optimistic.delete(key);
        }
      }
    },

    clearSession(workspaceId, agentSessionId) {
      const prefix = identityPrefix(workspaceId, agentSessionId);
      for (const key of optimistic.keys()) {
        if (key.startsWith(prefix)) optimistic.delete(key);
      }
      for (const key of canonical.keys()) {
        if (key.startsWith(prefix)) canonical.delete(key);
      }
    },

    project(messages) {
      const byKey = new Map<string, AgentActivityMessage>();
      for (const message of messages) {
        byKey.set(messageKey(message), cloneMessage(message));
      }
      for (const [key, entry] of optimistic) {
        const base = byKey.get(key) ?? canonical.get(key);
        byKey.set(
          key,
          base
            ? materialize(base, entry.message, entry.payloadUnset)
            : cloneMessage(entry.message)
        );
      }
      return [...byKey.values()].sort(compareAgentActivityMessages);
    }
  };

  function applyMessageDelta(
    event: AgentActivityMessageDeltaEvent
  ): AgentActivityOptimisticApplyResult {
    const data = event.data;
    if (
      data.workspaceId !== event.workspaceId ||
      data.agentSessionId !== event.agentSessionId
    ) {
      return {
        applied: false,
        needsReconcile: true,
        reason: "identity_mismatch"
      };
    }
    const key = liveMessageKey(event);
    const existing =
      optimistic.get(key)?.message ?? canonical.get(key) ?? undefined;
    if (data.content?.operation === "append_text" && !existing) {
      return {
        applied: false,
        needsReconcile: true,
        reason: "append_without_anchor"
      };
    }

    const next: AgentActivityMessage = existing
      ? cloneMessage(existing)
      : {
          workspaceId: event.workspaceId,
          agentSessionId: event.agentSessionId,
          messageId: data.messageId,
          version: 0,
          turnId: data.turnId ?? null,
          role: data.role,
          kind: data.kind,
          payload: {},
          occurredAtUnixMs: data.occurredAtUnixMs
        };
    next.workspaceId = event.workspaceId;
    next.agentSessionId = event.agentSessionId;
    next.turnId = data.turnId ?? next.turnId;
    next.role = data.role;
    next.kind = data.kind;
    next.occurredAtUnixMs = Math.max(
      next.occurredAtUnixMs,
      data.occurredAtUnixMs
    );

    if (data.content?.operation === "append_text") {
      const currentText =
        typeof next.payload.text === "string" ? next.payload.text : "";
      const text = currentText + data.content.text;
      next.payload.text = text;
      next.payload.content = text;
    } else if (data.content?.operation === "set") {
      const value = cloneJSONValue(data.content.value);
      next.payload.content = value;
      if (typeof value === "string") {
        next.payload.text = value;
      } else {
        delete next.payload.text;
      }
    }
    for (const [payloadKey, value] of Object.entries(data.payloadSet ?? {})) {
      next.payload[payloadKey] = cloneJSONValue(value);
    }
    for (const payloadKey of data.payloadUnset ?? []) {
      delete next.payload[payloadKey];
    }
    if (data.status !== undefined) next.status = data.status;
    if (data.semantics !== undefined) {
      next.semantics = cloneJSONValue(
        data.semantics
      ) as AgentActivityMessageSemantics;
    }
    if (data.startedAtUnixMs !== undefined) {
      next.startedAtUnixMs = data.startedAtUnixMs;
    }
    if (data.completedAtUnixMs !== undefined) {
      next.completedAtUnixMs = data.completedAtUnixMs;
    }
    const payloadUnset = new Set(optimistic.get(key)?.payloadUnset ?? []);
    for (const payloadKey of Object.keys(data.payloadSet ?? {})) {
      payloadUnset.delete(payloadKey);
    }
    for (const payloadKey of data.payloadUnset ?? []) {
      payloadUnset.add(payloadKey);
    }
    optimistic.set(key, {
      message: next,
      payloadUnset
    });
    return { applied: true, needsReconcile: false };
  }
}

function materialize(
  canonical: AgentActivityMessage,
  overlay: AgentActivityMessage,
  payloadUnset: ReadonlySet<string>
): AgentActivityMessage {
  const materialized = {
    ...canonical,
    ...overlay,
    version: canonical.version,
    sequence: canonical.sequence ?? overlay.sequence,
    createdAtUnixMs: canonical.createdAtUnixMs ?? overlay.createdAtUnixMs,
    payload: {
      ...canonical.payload,
      ...overlay.payload
    },
    semantics: overlay.semantics ?? canonical.semantics
  };
  for (const key of payloadUnset) {
    delete materialized.payload[key];
  }
  return materialized;
}

function isTerminalMessage(message: AgentActivityMessage): boolean {
  if (message.completedAtUnixMs !== undefined) return true;
  return ["completed", "failed", "canceled", "interrupted"].includes(
    message.status ?? ""
  );
}

function liveMessageKey(event: AgentActivityMessageDeltaEvent): string {
  return `${identityPrefix(event.workspaceId, event.agentSessionId)}${event.data.messageId}`;
}

function messageKey(message: AgentActivityMessage): string {
  return `${identityPrefix(message.workspaceId ?? "", message.agentSessionId)}${message.messageId}`;
}

function identityPrefix(workspaceId: string, agentSessionId: string): string {
  return `${workspaceId}\u0000${agentSessionId}\u0000`;
}

function cloneMessage(message: AgentActivityMessage): AgentActivityMessage {
  return mergeAgentActivityMessages([], [message])[0]!;
}
