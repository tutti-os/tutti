import { isLiveTurnLifecyclePhase } from "@tutti-os/agent-activity-core";
import type {
  AgentActivityRuntime,
  AgentQueuedPromptQueueSnapshot,
  AgentQueuedPromptRuntime
} from "@tutti-os/agent-gui";
import type {
  AgentActivitySession,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";

const ACTIVE_TURN_CONFLICT_MESSAGE = "agent session already has an active turn";

interface DesktopQueuedPromptReadyQueue {
  queue: AgentQueuedPromptQueueSnapshot;
  sessionStateUpdatedAtUnixMs: number | null;
}

interface DesktopQueuedPromptSkipReason {
  agentSessionId: string;
  activeTurnId?: string | null;
  blockedByRetryBlock?: boolean;
  claimOwnerId?: string | null;
  currentPhase?: unknown;
  failedPromptId?: string | null;
  promptId?: string | null;
  reason: string;
  retryBlock?: AgentQueuedPromptQueueSnapshot["retryBlock"];
  sessionStateUpdatedAtUnixMs?: number | null;
  status?: unknown;
  submitAvailabilityReason?: unknown;
  submitAvailabilityState?: unknown;
  turnLifecyclePhase?: unknown;
}

interface DesktopQueuedPromptSendNextInterrupt {
  promptId: string;
  queue: AgentQueuedPromptQueueSnapshot;
  sessionStateUpdatedAtUnixMs: number | null;
}

export interface CreateDesktopAgentQueuedPromptDrainCoordinatorInput {
  agentActivityRuntime: AgentActivityRuntime;
  agentQueuedPromptRuntime: AgentQueuedPromptRuntime;
  workspaceId: string;
}

export function createDesktopAgentQueuedPromptDrainCoordinator({
  agentActivityRuntime,
  agentQueuedPromptRuntime,
  workspaceId
}: CreateDesktopAgentQueuedPromptDrainCoordinatorInput): () => void {
  const ownerId = `desktop-agent-gui-queued-prompt-drain-coordinator:${workspaceId}`;
  let disposed = false;
  let draining = false;
  let scheduled = false;
  let activitySnapshot = emptyActivitySnapshot(workspaceId);
  const sendNextInterruptBlocks = new Map<string, number | null>();

  const scheduleDrain = (): void => {
    if (disposed || scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void drain();
    });
  };

  const unsubscribeQueue = agentQueuedPromptRuntime.subscribe(scheduleDrain);
  const unsubscribeActivity = agentActivityRuntime.subscribe(
    workspaceId,
    (snapshot) => {
      activitySnapshot = snapshot;
      scheduleDrain();
    }
  );
  logDesktopQueuedPromptDrainer("started", {
    workspaceId,
    ownerId
  });

  const drain = async (): Promise<void> => {
    if (disposed || draining) {
      return;
    }
    draining = true;
    try {
      while (!disposed) {
        const queueSnapshot = agentQueuedPromptRuntime.getSnapshot();
        if (!hasQueuedPrompts(queueSnapshot, workspaceId)) {
          return;
        }
        activitySnapshot = agentActivityRuntime.getSnapshot(workspaceId);
        logDesktopQueuedPromptDrainer("scan", {
          workspaceId,
          ownerId,
          queues: summarizeQueueSnapshot(queueSnapshot, workspaceId),
          sessions: summarizeActivitySnapshot(activitySnapshot)
        });
        const sendNextInterrupt = findSendNextInterrupt(
          queueSnapshot,
          activitySnapshot,
          workspaceId,
          sendNextInterruptBlocks
        );
        if (sendNextInterrupt) {
          const interruptKey = queueKey(
            workspaceId,
            sendNextInterrupt.queue.agentSessionId
          );
          sendNextInterruptBlocks.set(
            interruptKey,
            sendNextInterrupt.sessionStateUpdatedAtUnixMs
          );
          logDesktopQueuedPromptDrainer("send-next-interrupt-start", {
            workspaceId,
            ownerId,
            agentSessionId: sendNextInterrupt.queue.agentSessionId,
            queuedPromptId: sendNextInterrupt.promptId,
            sessionStateUpdatedAtUnixMs:
              sendNextInterrupt.sessionStateUpdatedAtUnixMs
          });
          try {
            const result = await agentActivityRuntime.cancelSession({
              workspaceId,
              agentSessionId: sendNextInterrupt.queue.agentSessionId
            });
            logDesktopQueuedPromptDrainer("send-next-interrupt-complete", {
              workspaceId,
              ownerId,
              agentSessionId: sendNextInterrupt.queue.agentSessionId,
              queuedPromptId: sendNextInterrupt.promptId,
              canceled: result.canceled,
              reason: result.reason ?? null,
              sessionStatus: result.session?.status ?? null
            });
          } catch (error) {
            logDesktopQueuedPromptDrainer("send-next-interrupt-error", {
              workspaceId,
              ownerId,
              agentSessionId: sendNextInterrupt.queue.agentSessionId,
              queuedPromptId: sendNextInterrupt.promptId,
              errorMessage: rawErrorMessage(error)
            });
          }
          continue;
        }
        const readyQueueResult = findReadyQueue(
          queueSnapshot,
          activitySnapshot,
          workspaceId
        );
        const readyQueue = readyQueueResult.readyQueue;
        if (!readyQueue) {
          logDesktopQueuedPromptDrainer("skip-not-ready", {
            workspaceId,
            ownerId,
            skipped: readyQueueResult.skipped
          });
          return;
        }
        const claimResult = agentQueuedPromptRuntime.claimNextToDrain({
          workspaceId,
          agentSessionId: readyQueue.queue.agentSessionId,
          ownerId
        });
        if (!claimResult) {
          continue;
        }
        logDesktopQueuedPromptDrainer("send-start", {
          workspaceId,
          ownerId,
          agentSessionId: readyQueue.queue.agentSessionId,
          queuedPromptId: claimResult.prompt.id,
          claimId: claimResult.claim.claimId,
          sessionStateUpdatedAtUnixMs: readyQueue.sessionStateUpdatedAtUnixMs
        });
        let claimCompleted = false;
        try {
          await agentActivityRuntime.sendInput({
            workspaceId,
            agentSessionId: readyQueue.queue.agentSessionId,
            content: [...claimResult.prompt.content],
            displayPrompt: claimResult.prompt.displayPrompt ?? null
          });
          claimCompleted = agentQueuedPromptRuntime.completeClaim({
            workspaceId,
            agentSessionId: readyQueue.queue.agentSessionId,
            ownerId,
            claimId: claimResult.claim.claimId
          });
          sendNextInterruptBlocks.delete(
            queueKey(workspaceId, readyQueue.queue.agentSessionId)
          );
          logDesktopQueuedPromptDrainer("send-complete-claim", {
            workspaceId,
            ownerId,
            agentSessionId: readyQueue.queue.agentSessionId,
            queuedPromptId: claimResult.prompt.id,
            claimId: claimResult.claim.claimId,
            completed: claimCompleted
          });
        } catch (error) {
          const retryBlockVersion = readyQueue.sessionStateUpdatedAtUnixMs;
          const activeTurnConflict = isActiveTurnConflictError(error);
          logDesktopQueuedPromptDrainer("send-error", {
            workspaceId,
            ownerId,
            agentSessionId: readyQueue.queue.agentSessionId,
            queuedPromptId: claimResult.prompt.id,
            claimId: claimResult.claim.claimId,
            activeTurnConflict,
            errorMessage: rawErrorMessage(error),
            sessionStateUpdatedAtUnixMs: retryBlockVersion
          });
          if (activeTurnConflict) {
            agentQueuedPromptRuntime.setRetryBlock({
              workspaceId,
              agentSessionId: readyQueue.queue.agentSessionId,
              retryBlock: {
                queuedPromptId: claimResult.prompt.id,
                sessionStateUpdatedAtUnixMs: retryBlockVersion,
                conversationUpdatedAtUnixMs: null
              }
            });
          } else {
            agentQueuedPromptRuntime.markPromptFailed({
              workspaceId,
              agentSessionId: readyQueue.queue.agentSessionId,
              promptId: claimResult.prompt.id
            });
          }
        } finally {
          if (!claimCompleted) {
            agentQueuedPromptRuntime.releaseClaim({
              workspaceId,
              agentSessionId: readyQueue.queue.agentSessionId,
              ownerId,
              claimId: claimResult.claim.claimId
            });
          }
        }
      }
    } finally {
      draining = false;
    }
  };

  scheduleDrain();

  return () => {
    disposed = true;
    unsubscribeActivity();
    unsubscribeQueue();
    logDesktopQueuedPromptDrainer("stopped", {
      workspaceId,
      ownerId,
      releaseClaimsOnDispose: false
    });
  };
}

function emptyActivitySnapshot(workspaceId: string): AgentActivitySnapshot {
  return {
    workspaceId,
    sessions: [],
    presences: [],
    sessionMessagesById: {}
  };
}

function hasQueuedPrompts(
  queueSnapshot: ReturnType<AgentQueuedPromptRuntime["getSnapshot"]>,
  workspaceId: string
): boolean {
  return Object.values(queueSnapshot.queuesByKey).some(
    (queue) => queue.workspaceId === workspaceId && queue.prompts.length > 0
  );
}

function findSendNextInterrupt(
  queueSnapshot: ReturnType<AgentQueuedPromptRuntime["getSnapshot"]>,
  activitySnapshot: AgentActivitySnapshot,
  workspaceId: string,
  interruptBlocks: ReadonlyMap<string, number | null>
): DesktopQueuedPromptSendNextInterrupt | null {
  for (const queue of Object.values(queueSnapshot.queuesByKey)) {
    if (queue.workspaceId !== workspaceId || queue.claim) {
      continue;
    }
    const queuedPrompt = queue.prompts[0] ?? null;
    const sendNextPromptId = queue.sendNextPromptId?.trim() ?? "";
    if (
      !queuedPrompt ||
      !sendNextPromptId ||
      queuedPrompt.id !== sendNextPromptId ||
      queuedPrompt.id === queue.failedPromptId
    ) {
      continue;
    }
    const session = findActivitySession(activitySnapshot, queue.agentSessionId);
    if (!session || !sessionLooksBusy(session)) {
      continue;
    }
    const sessionStateUpdatedAtUnixMs = sessionActivityVersion(session);
    const interruptKey = queueKey(workspaceId, queue.agentSessionId);
    if (interruptBlocks.get(interruptKey) === sessionStateUpdatedAtUnixMs) {
      continue;
    }
    return {
      promptId: queuedPrompt.id,
      queue,
      sessionStateUpdatedAtUnixMs
    };
  }
  return null;
}

function findReadyQueue(
  queueSnapshot: ReturnType<AgentQueuedPromptRuntime["getSnapshot"]>,
  activitySnapshot: AgentActivitySnapshot,
  workspaceId: string
): {
  readyQueue: DesktopQueuedPromptReadyQueue | null;
  skipped: DesktopQueuedPromptSkipReason[];
} {
  const skipped: DesktopQueuedPromptSkipReason[] = [];
  for (const queue of Object.values(queueSnapshot.queuesByKey)) {
    if (queue.workspaceId !== workspaceId) {
      continue;
    }
    const queuedPrompt = queue.prompts[0] ?? null;
    if (!queuedPrompt) {
      skipped.push({
        agentSessionId: queue.agentSessionId,
        promptId: null,
        reason: "empty-queue"
      });
      continue;
    }
    if (queue.claim) {
      skipped.push({
        agentSessionId: queue.agentSessionId,
        claimOwnerId: queue.claim.ownerId,
        promptId: queuedPrompt.id,
        reason: "claimed"
      });
      continue;
    }
    if (queuedPrompt.id === queue.failedPromptId) {
      skipped.push({
        agentSessionId: queue.agentSessionId,
        failedPromptId: queue.failedPromptId,
        promptId: queuedPrompt.id,
        reason: "failed-head"
      });
      continue;
    }
    const session = findActivitySession(activitySnapshot, queue.agentSessionId);
    if (!session) {
      skipped.push({
        agentSessionId: queue.agentSessionId,
        promptId: queuedPrompt.id,
        reason: "missing-activity-session"
      });
      continue;
    }
    const sessionStateUpdatedAtUnixMs = sessionActivityVersion(session);
    if (!sessionCanReceiveInput(session)) {
      skipped.push({
        agentSessionId: queue.agentSessionId,
        activeTurnId: session.turnLifecycle?.activeTurnId ?? null,
        currentPhase: session.currentPhase,
        promptId: queuedPrompt.id,
        reason: "session-not-ready",
        sessionStateUpdatedAtUnixMs,
        status: session.status,
        submitAvailabilityReason: session.submitAvailability?.reason,
        submitAvailabilityState: session.submitAvailability?.state,
        turnLifecyclePhase: session.turnLifecycle?.phase
      });
      continue;
    }
    const blockedByRetryBlock =
      queue.retryBlock?.queuedPromptId === queuedPrompt.id &&
      queue.retryBlock.sessionStateUpdatedAtUnixMs ===
        sessionStateUpdatedAtUnixMs;
    if (blockedByRetryBlock) {
      skipped.push({
        agentSessionId: queue.agentSessionId,
        blockedByRetryBlock,
        promptId: queuedPrompt.id,
        reason: "retry-block",
        retryBlock: queue.retryBlock,
        sessionStateUpdatedAtUnixMs
      });
      continue;
    }
    return {
      readyQueue: { queue, sessionStateUpdatedAtUnixMs },
      skipped
    };
  }
  return { readyQueue: null, skipped };
}

function findActivitySession(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string
): AgentActivitySession | null {
  return (
    snapshot.sessions.find(
      (session) => session.agentSessionId === agentSessionId
    ) ?? null
  );
}

function queueKey(workspaceId: string, agentSessionId: string): string {
  return `${workspaceId.trim()}\0${agentSessionId.trim()}`;
}

function sessionCanReceiveInput(session: AgentActivitySession): boolean {
  if (sessionLooksBusy(session)) {
    return false;
  }
  const submitState = session.submitAvailability?.state;
  if (!submitState || submitState === "available") {
    return true;
  }
  if (submitState !== "blocked") {
    return false;
  }
  return (
    normalizeActivityToken(session.submitAvailability?.reason) === "active_turn"
  );
}

function sessionLooksBusy(session: AgentActivitySession): boolean {
  // The turn lifecycle is the source of truth (ADR 0008): a present
  // lifecycle decides entirely; the status/currentPhase token lists apply
  // only to records without a lifecycle (non-migrated providers).
  const lifecycle = session.turnLifecycle;
  if (lifecycle?.phase) {
    return (
      Boolean(lifecycle.activeTurnId) &&
      isLiveTurnLifecyclePhase(lifecycle.phase)
    );
  }
  const status = normalizeActivityToken(session.status);
  const currentPhase = normalizeActivityToken(session.currentPhase);
  return (
    status === "queued" ||
    status === "working" ||
    status === "running" ||
    status === "waiting" ||
    currentPhase === "queued" ||
    currentPhase === "submitted" ||
    currentPhase === "running" ||
    currentPhase === "working" ||
    currentPhase === "waiting" ||
    Boolean(lifecycle?.activeTurnId)
  );
}

function sessionActivityVersion(
  session: AgentActivitySession | null
): number | null {
  return (
    session?.updatedAtUnixMs ??
    session?.lastEventUnixMs ??
    session?.messageVersion ??
    session?.createdAtUnixMs ??
    session?.startedAtUnixMs ??
    null
  );
}

function normalizeActivityToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isActiveTurnConflictError(error: unknown): boolean {
  return (
    rawErrorMessage(error)
      ?.toLowerCase()
      .includes(ACTIVE_TURN_CONFLICT_MESSAGE) ?? false
  );
}

function rawErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object") {
    const debugMessage = (error as { debugMessage?: unknown }).debugMessage;
    if (typeof debugMessage === "string" && debugMessage.trim()) {
      return debugMessage.trim();
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return null;
}

function logDesktopQueuedPromptDrainer(
  event: string,
  details: Record<string, unknown>
): void {
  void event;
  void details;
}

function summarizeQueueSnapshot(
  snapshot: ReturnType<AgentQueuedPromptRuntime["getSnapshot"]>,
  workspaceId: string
): Array<{
  agentSessionId: string;
  claimOwnerId: string | null;
  claimPromptId: string | null;
  failedPromptId: string | null;
  promptIds: string[];
  retryBlock: AgentQueuedPromptQueueSnapshot["retryBlock"];
}> {
  return Object.values(snapshot.queuesByKey)
    .filter((queue) => queue.workspaceId === workspaceId)
    .map((queue) => ({
      agentSessionId: queue.agentSessionId,
      claimOwnerId: queue.claim?.ownerId ?? null,
      claimPromptId: queue.claim?.promptId ?? null,
      failedPromptId: queue.failedPromptId,
      promptIds: queue.prompts.map((prompt) => prompt.id),
      retryBlock: queue.retryBlock
    }));
}

function summarizeActivitySnapshot(snapshot: AgentActivitySnapshot): Array<{
  agentSessionId: string;
  activeTurnId?: string | null;
  currentPhase?: unknown;
  status?: unknown;
  submitAvailabilityReason?: unknown;
  submitAvailabilityState?: unknown;
  turnLifecyclePhase?: unknown;
  updatedAtUnixMs?: number | null;
}> {
  return snapshot.sessions.map((session) => ({
    agentSessionId: session.agentSessionId,
    activeTurnId: session.turnLifecycle?.activeTurnId ?? null,
    currentPhase: session.currentPhase,
    status: session.status,
    submitAvailabilityReason: session.submitAvailability?.reason,
    submitAvailabilityState: session.submitAvailability?.state,
    turnLifecyclePhase: session.turnLifecycle?.phase,
    updatedAtUnixMs: sessionActivityVersion(session)
  }));
}
