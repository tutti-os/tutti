import {
  createAgentActivityEphemeralConversationProjector,
  type AgentActivityEphemeralConversationProjection,
  type AgentActivityEphemeralConversationProjector,
  type AgentActivityInteraction
} from "@tutti-os/agent-activity-core";
import type { AgentSideUpdatedPayloadV1 } from "@tutti-os/event-protocol";
import { normalizeAgentSideConversationEvent } from "./agentSideConversationProjection.ts";
import type {
  AgentSideCapabilities,
  AgentSideConversationRuntime,
  AgentSideConversationSnapshot,
  AgentSideConversationState,
  AgentSideInteraction
} from "./agentSideConversationRuntime";

export type { AgentSideConversationRuntime } from "./agentSideConversationRuntime";

export interface AgentSideConversationTransport {
  resolveCapabilities(
    workspaceId: string,
    sourceAgentSessionId: string
  ): Promise<AgentSideCapabilities>;
  open(input: {
    workspaceId: string;
    sourceAgentSessionId: string;
    sideAgentSessionId: string;
    requestId: string;
  }): Promise<{ status: string }>;
  send(input: {
    workspaceId: string;
    sideAgentSessionId: string;
    turnId: string;
    clientSubmitId: string;
    content: Parameters<AgentSideConversationRuntime["send"]>[0]["content"];
    displayPrompt?: string;
  }): Promise<void>;
  cancel(input: {
    workspaceId: string;
    sideAgentSessionId: string;
    turnId: string;
  }): Promise<void>;
  respond(
    input: Parameters<AgentSideConversationRuntime["respond"]>[0]
  ): Promise<void>;
  close(input: {
    workspaceId: string;
    sideAgentSessionId: string;
  }): Promise<void>;
  subscribe(
    listener: (event: AgentSideConversationStreamEvent) => void
  ): () => void;
  subscribeConnectionState(
    listener: (
      state: "connected" | "connecting" | "disconnected" | "disposed"
    ) => void
  ): () => void;
  getConnectionState():
    | "connected"
    | "connecting"
    | "disconnected"
    | "disposed";
}

export type AgentSideConversationStreamEvent = AgentSideUpdatedPayloadV1;

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function interactionFromProjection(
  interaction: AgentActivityInteraction | null
): AgentSideInteraction | null {
  if (!interaction || interaction.status !== "pending") return null;
  const rawActions = Array.isArray(interaction.metadata?.actions)
    ? interaction.metadata.actions
    : [];
  return {
    requestId: interaction.requestId,
    turnId: interaction.turnId,
    kind: interaction.kind,
    toolName: interaction.toolName ?? null,
    input: interaction.input ?? {},
    actions: rawActions.flatMap((rawAction) => {
      if (!rawAction || typeof rawAction !== "object") return [];
      const action = rawAction as Record<string, unknown>;
      const id = typeof action.id === "string" ? action.id : "";
      if (!id) return [];
      return [
        {
          id,
          label: typeof action.label === "string" ? action.label : id,
          semantic: typeof action.semantic === "string" ? action.semantic : ""
        }
      ];
    })
  };
}

function stateFromProjection(
  current: AgentSideConversationState,
  projection: AgentActivityEphemeralConversationProjection
): AgentSideConversationState {
  const session = projection.activitySnapshot.sessions[0] ?? null;
  const pendingInteraction =
    session?.pendingInteractions.at(-1) ??
    projection.interactions.findLast(
      (interaction) => interaction.status === "pending"
    ) ??
    null;
  return {
    ...current,
    status: projection.expired
      ? "expired"
      : current.status === "opening" ||
          current.status === "closing" ||
          current.status === "error"
        ? current.status
        : session?.activeTurnId
          ? "running"
          : "idle",
    activeTurnId: projection.expired ? null : (session?.activeTurnId ?? null),
    projection,
    pendingInteraction: interactionFromProjection(pendingInteraction),
    sequence: projection.sequence
  };
}

export function createAgentSideConversationRuntime(
  transport: AgentSideConversationTransport
): AgentSideConversationRuntime & { dispose(): void } {
  const snapshots = new Map<string, AgentSideConversationSnapshot>();
  const projectors = new Map<
    string,
    AgentActivityEphemeralConversationProjector
  >();
  const pendingCloses = new Map<
    string,
    { workspaceId: string; sideAgentSessionId: string }
  >();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (workspaceId: string) => {
    for (const listener of listeners.get(workspaceId) ?? []) listener();
  };
  const setActive = (
    workspaceId: string,
    active: AgentSideConversationState | null
  ) => {
    snapshots.set(workspaceId, { workspaceId, active });
    notify(workspaceId);
  };
  const closeWithTombstone = async (closeIdentity: {
    workspaceId: string;
    sideAgentSessionId: string;
  }) => {
    pendingCloses.set(closeIdentity.workspaceId, closeIdentity);
    await transport.close(closeIdentity);
    if (
      pendingCloses.get(closeIdentity.workspaceId)?.sideAgentSessionId ===
      closeIdentity.sideAgentSessionId
    ) {
      pendingCloses.delete(closeIdentity.workspaceId);
    }
  };
  const expireAndClose = (
    workspaceId: string,
    active: AgentSideConversationState
  ) => {
    const closeIdentity = {
      workspaceId,
      sideAgentSessionId: active.sideAgentSessionId
    };
    projectors.delete(active.sideAgentSessionId);
    setActive(workspaceId, null);
    void closeWithTombstone(closeIdentity).catch(() => {});
  };
  const handleEvent = (event: AgentSideConversationStreamEvent) => {
    const active = snapshots.get(event.workspaceId)?.active;
    if (!active || active.sideAgentSessionId !== event.sideAgentSessionId) {
      return;
    }
    const projector = projectors.get(active.sideAgentSessionId);
    if (!projector) {
      expireAndClose(event.workspaceId, active);
      return;
    }
    const result = projector.apply(normalizeAgentSideConversationEvent(event));
    if (result.expired) {
      expireAndClose(event.workspaceId, active);
      return;
    }
    if (!result.applied) return;
    setActive(
      event.workspaceId,
      stateFromProjection(active, projector.getSnapshot())
    );
  };
  const handleConnectionState = (
    state: "connected" | "connecting" | "disconnected" | "disposed"
  ) => {
    if (state !== "disconnected" && state !== "disposed") return;
    for (const [workspaceId, snapshot] of snapshots) {
      if (!snapshot.active) continue;
      expireAndClose(workspaceId, snapshot.active);
    }
  };
  let eventUnsubscribe: (() => void) | null = null;
  let connectionUnsubscribe: (() => void) | null = null;
  let connectionState = transport.getConnectionState();
  const ensureTransportSubscriptions = () => {
    if (eventUnsubscribe) return;
    connectionState = transport.getConnectionState();
    eventUnsubscribe = transport.subscribe(handleEvent);
    connectionUnsubscribe = transport.subscribeConnectionState((state) => {
      connectionState = state;
      handleConnectionState(state);
    });
    connectionState = transport.getConnectionState();
    handleConnectionState(connectionState);
  };
  const releaseTransportSubscriptionsIfUnused = () => {
    const hasListeners = [...listeners.values()].some(
      (workspaceListeners) => workspaceListeners.size > 0
    );
    const hasActiveSide = [...snapshots.values()].some(
      (snapshot) => snapshot.active !== null
    );
    if (hasListeners || hasActiveSide) return;
    eventUnsubscribe?.();
    connectionUnsubscribe?.();
    eventUnsubscribe = null;
    connectionUnsubscribe = null;
  };

  return {
    resolveCapabilities: ({ workspaceId, sourceAgentSessionId }) =>
      transport.resolveCapabilities(workspaceId, sourceAgentSessionId),
    async open({ workspaceId, sourceAgentSessionId, provider, cwd }) {
      ensureTransportSubscriptions();
      connectionState = transport.getConnectionState();
      if (connectionState !== "connected") {
        releaseTransportSubscriptionsIfUnused();
        throw new Error("event_stream_unavailable");
      }
      const existingActive = snapshots.get(workspaceId)?.active;
      if (existingActive) {
        const failedClose = pendingCloses.get(workspaceId);
        if (
          existingActive.status === "error" &&
          existingActive.error === "side_close_failed" &&
          failedClose?.sideAgentSessionId === existingActive.sideAgentSessionId
        ) {
          await closeWithTombstone(failedClose);
          projectors.delete(existingActive.sideAgentSessionId);
          setActive(workspaceId, null);
        } else {
          throw new Error("A Side conversation is already active.");
        }
      }
      const pendingClose = pendingCloses.get(workspaceId);
      if (pendingClose) {
        await transport.close(pendingClose);
        pendingCloses.delete(workspaceId);
      }
      connectionState = transport.getConnectionState();
      if (connectionState !== "connected") {
        releaseTransportSubscriptionsIfUnused();
        throw new Error("event_stream_unavailable");
      }
      const sideAgentSessionId = newId();
      const projector = createAgentActivityEphemeralConversationProjector({
        workspaceId,
        agentSessionId: sideAgentSessionId,
        sourceAgentSessionId,
        provider: provider?.trim() || "unknown",
        cwd: cwd?.trim() || null
      });
      projectors.set(sideAgentSessionId, projector);
      const state: AgentSideConversationState = {
        workspaceId,
        sourceAgentSessionId,
        sideAgentSessionId,
        status: "opening",
        activeTurnId: null,
        projection: projector.getSnapshot(),
        pendingInteraction: null,
        error: null,
        sequence: 0
      };
      setActive(workspaceId, state);
      try {
        await transport.open({
          workspaceId,
          sourceAgentSessionId,
          sideAgentSessionId,
          requestId: newId()
        });
        const current = snapshots.get(workspaceId)?.active;
        if (!current || current.sideAgentSessionId !== sideAgentSessionId) {
          projectors.delete(sideAgentSessionId);
          await closeWithTombstone({ workspaceId, sideAgentSessionId });
          throw new Error("Side conversation identity changed while opening.");
        }
        const opened: AgentSideConversationState = {
          ...stateFromProjection(current, projector.getSnapshot()),
          status: projector.getSnapshot().activitySnapshot.sessions[0]
            ?.activeTurnId
            ? "running"
            : "idle",
          error: null
        };
        setActive(workspaceId, opened);
        return opened;
      } catch (error) {
        const current = snapshots.get(workspaceId)?.active;
        if (
          current?.sideAgentSessionId === sideAgentSessionId &&
          current.status === "opening"
        ) {
          setActive(workspaceId, {
            ...current,
            status: "error",
            error: "side_open_failed"
          });
        }
        throw error;
      }
    },
    async send(input) {
      const turnId = newId();
      const active = snapshots.get(input.workspaceId)?.active;
      const projector = active
        ? projectors.get(active.sideAgentSessionId)
        : null;
      if (
        !active ||
        active.sideAgentSessionId !== input.sideAgentSessionId ||
        !projector
      ) {
        throw new Error("Side conversation is not active.");
      }
      if (active.status !== "idle" || active.activeTurnId) {
        throw new Error("Side conversation is not ready for input.");
      }
      if (input.content.some((block) => block.type === "file")) {
        setActive(input.workspaceId, {
          ...active,
          error: "content_unsupported"
        });
        throw new Error("content_unsupported");
      }
      const text =
        input.displayPrompt ??
        input.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("");
      projector.beginTurn({
        turnId,
        content: text,
        displayPrompt: input.displayPrompt
      });
      setActive(input.workspaceId, {
        ...stateFromProjection(active, projector.getSnapshot()),
        status: "running",
        error: null
      });
      try {
        await transport.send({
          ...input,
          turnId,
          clientSubmitId: newId()
        });
      } catch (error) {
        projector.failTurn({
          turnId,
          message: error instanceof Error ? error.message : null
        });
        const current = snapshots.get(input.workspaceId)?.active;
        if (current?.sideAgentSessionId === input.sideAgentSessionId) {
          setActive(input.workspaceId, {
            ...stateFromProjection(current, projector.getSnapshot()),
            status: "error",
            error: "side_send_failed"
          });
        }
        throw error;
      }
    },
    async cancel(input) {
      const active = snapshots.get(input.workspaceId)?.active;
      if (
        !active ||
        active.sideAgentSessionId !== input.sideAgentSessionId ||
        active.activeTurnId !== input.turnId
      ) {
        throw new Error("Side turn is not active.");
      }
      await transport.cancel(input);
    },
    async respond(input) {
      const active = snapshots.get(input.workspaceId)?.active;
      if (
        !active ||
        active.sideAgentSessionId !== input.sideAgentSessionId ||
        active.pendingInteraction?.turnId !== input.turnId ||
        active.pendingInteraction.requestId !== input.requestId
      ) {
        throw new Error("Side interaction is not active.");
      }
      try {
        await transport.respond(input);
        const current = snapshots.get(input.workspaceId)?.active;
        if (current?.sideAgentSessionId === input.sideAgentSessionId) {
          setActive(input.workspaceId, { ...current, error: null });
        }
      } catch (error) {
        const current = snapshots.get(input.workspaceId)?.active;
        if (current?.sideAgentSessionId === input.sideAgentSessionId) {
          setActive(input.workspaceId, {
            ...current,
            error: "side_interaction_failed"
          });
        }
        throw error;
      }
    },
    async close(input) {
      const active = snapshots.get(input.workspaceId)?.active;
      if (active?.sideAgentSessionId === input.sideAgentSessionId) {
        setActive(input.workspaceId, {
          ...active,
          status: "closing",
          error: null
        });
      }
      try {
        await closeWithTombstone(input);
        const current = snapshots.get(input.workspaceId)?.active;
        if (current?.sideAgentSessionId === input.sideAgentSessionId) {
          projectors.delete(input.sideAgentSessionId);
          setActive(input.workspaceId, null);
        }
        releaseTransportSubscriptionsIfUnused();
      } catch (error) {
        const current = snapshots.get(input.workspaceId)?.active;
        if (current?.sideAgentSessionId === input.sideAgentSessionId) {
          setActive(input.workspaceId, {
            ...current,
            status: "error",
            error: "side_close_failed"
          });
        }
        throw error;
      }
    },
    getSnapshot(workspaceId) {
      const snapshot = snapshots.get(workspaceId);
      if (snapshot) return snapshot;
      const empty = { workspaceId, active: null };
      snapshots.set(workspaceId, empty);
      return empty;
    },
    subscribe(workspaceId, listener) {
      ensureTransportSubscriptions();
      let workspaceListeners = listeners.get(workspaceId);
      if (!workspaceListeners) {
        workspaceListeners = new Set();
        listeners.set(workspaceId, workspaceListeners);
      }
      workspaceListeners.add(listener);
      return () => {
        workspaceListeners?.delete(listener);
        if (workspaceListeners?.size === 0) listeners.delete(workspaceId);
        releaseTransportSubscriptionsIfUnused();
      };
    },
    dispose() {
      eventUnsubscribe?.();
      connectionUnsubscribe?.();
      eventUnsubscribe = null;
      connectionUnsubscribe = null;
      for (const snapshot of snapshots.values()) {
        if (!snapshot.active) continue;
        void transport
          .close({
            workspaceId: snapshot.workspaceId,
            sideAgentSessionId: snapshot.active.sideAgentSessionId
          })
          .catch(() => {});
      }
      for (const pendingClose of pendingCloses.values()) {
        void transport.close(pendingClose).catch(() => {});
      }
      listeners.clear();
      snapshots.clear();
      projectors.clear();
      pendingCloses.clear();
    }
  };
}
