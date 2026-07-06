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
  availabilityProbe?: DesktopQueuedPromptAvailabilityProbe;
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

// Diagnostic-only probe (temporary instrumentation): compares the wire
// submitAvailability with a value derived from turnLifecycle +
// runtimeContext.backgroundAgents, to validate two hypotheses in the field:
// (1) the wire value goes stale while the lifecycle stays correct, and
// (2) backgroundAgents never reaches this record over the push channel.
interface DesktopQueuedPromptAvailabilityProbe {
  backgroundAgents: {
    present: boolean;
    count: number | null;
    liveItemCount: number | null;
  };
  derivedReason: string | null;
  derivedState: string | null;
  wireReason: string | null;
  wireState: string | null;
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
  const logDrainer = (event: string, details: Record<string, unknown>): void =>
    reportDesktopQueuedPromptDrainerDiagnostic(
      agentActivityRuntime,
      event,
      details
    );
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
  logDrainer("started", {
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
        logDrainer("scan", {
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
          logDrainer("send-next-interrupt-start", {
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
            logDrainer("send-next-interrupt-complete", {
              workspaceId,
              ownerId,
              agentSessionId: sendNextInterrupt.queue.agentSessionId,
              queuedPromptId: sendNextInterrupt.promptId,
              canceled: result.canceled,
              reason: result.reason ?? null,
              sessionStatus: result.session?.status ?? null
            });
          } catch (error) {
            logDrainer("send-next-interrupt-error", {
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
          logDrainer("skip-not-ready", {
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
        const readySession = findActivitySession(
          activitySnapshot,
          readyQueue.queue.agentSessionId
        );
        logDrainer("send-start", {
          workspaceId,
          ownerId,
          agentSessionId: readyQueue.queue.agentSessionId,
          availabilityProbe: readySession
            ? describeSessionAvailabilityProbe(readySession)
            : null,
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
          logDrainer("send-complete-claim", {
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
          logDrainer("send-error", {
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
    logDrainer("stopped", {
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
        availabilityProbe: describeSessionAvailabilityProbe(session),
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
  // The turn lifecycle is the source of truth (ADR 0008): sessionLooksBusy
  // already proved the lifecycle holds no live turn, so a leftover
  // blocked(active_turn) submit availability is stale — after the turn
  // settles no further event arrives to refresh it, and waiting on it would
  // strand the queued prompts forever. Other blocked reasons still hold.
  if (
    submitState === "blocked" &&
    session.submitAvailability?.reason === "active_turn" &&
    Boolean(session.turnLifecycle?.phase)
  ) {
    return true;
  }
  return false;
}

function sessionLooksBusy(session: AgentActivitySession): boolean {
  // The turn lifecycle is the source of truth (ADR 0008): a present
  // lifecycle decides entirely; the status/currentPhase token lists apply
  // only to records without a lifecycle (non-migrated providers).
  const lifecycle = session.turnLifecycle;
  if (lifecycle?.phase) {
    return (
      Boolean(lifecycle.activeTurnId) ||
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
    currentPhase === "waiting"
  );
}

// Mirrors Go submitAvailabilityForAuthoritySession (runtime/controller.go)
// for diagnostics only: derive availability from lifecycle + backgroundAgents
// and report it next to the wire value so field logs show where they diverge.
function describeSessionAvailabilityProbe(
  session: AgentActivitySession
): DesktopQueuedPromptAvailabilityProbe {
  const backgroundAgents = backgroundAgentsProbe(session);
  let derivedState: string | null = null;
  let derivedReason: string | null = null;
  const lifecycle = session.turnLifecycle;
  if (lifecycle?.phase || lifecycle?.activeTurnId) {
    if (isWaitingTurnLifecyclePhase(lifecycle.phase)) {
      derivedState = "blocked";
      derivedReason = "waiting";
    } else if (
      Boolean(lifecycle.activeTurnId) ||
      isLiveTurnLifecyclePhase(lifecycle.phase)
    ) {
      derivedState = "blocked";
      derivedReason = "active_turn";
    } else if (
      (backgroundAgents.count ?? 0) > 0 ||
      (backgroundAgents.liveItemCount ?? 0) > 0
    ) {
      derivedState = "blocked";
      derivedReason = "background_agent";
    } else {
      derivedState = "available";
    }
  }
  return {
    backgroundAgents,
    derivedReason,
    derivedState,
    wireReason: session.submitAvailability?.reason ?? null,
    wireState: session.submitAvailability?.state ?? null
  };
}

function backgroundAgentsProbe(
  session: AgentActivitySession
): DesktopQueuedPromptAvailabilityProbe["backgroundAgents"] {
  const runtimeContext = session.runtimeContext as
    | Record<string, unknown>
    | undefined;
  const backgroundAgents = runtimeContext?.backgroundAgents as
    | { count?: unknown; items?: unknown }
    | undefined;
  if (!backgroundAgents || typeof backgroundAgents !== "object") {
    return { present: false, count: null, liveItemCount: null };
  }
  const count =
    typeof backgroundAgents.count === "number" ? backgroundAgents.count : null;
  const items = Array.isArray(backgroundAgents.items)
    ? backgroundAgents.items
    : null;
  const liveItemCount =
    items === null
      ? null
      : items.filter((item) => {
          const status =
            item && typeof item === "object"
              ? normalizeActivityToken((item as { status?: unknown }).status)
              : "";
          // Mirror Go claudeSDKBackgroundAgentStatusIsTerminal: absent status
          // counts as running.
          return !(
            status === "completed" ||
            status === "failed" ||
            status === "cancelled" ||
            status === "canceled" ||
            status === "stopped"
          );
        }).length;
  return { present: true, count, liveItemCount };
}

function isWaitingTurnLifecyclePhase(phase: unknown): boolean {
  switch (normalizeActivityToken(phase)) {
    case "waiting":
    case "waiting_approval":
    case "waiting_input":
    case "awaiting_approval":
      return true;
    default:
      return false;
  }
}

function isLiveTurnLifecyclePhase(phase: unknown): boolean {
  switch (normalizeActivityToken(phase)) {
    case "submitted":
    case "running":
    case "waiting_approval":
    case "waiting_input":
    case "working":
    case "streaming":
    case "waiting":
    case "awaiting_approval":
      return true;
    default:
      return false;
  }
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

// Drain decisions (especially skip reasons) are invisible without this: a
// stranded queue looks like "nothing happened". Route them through the
// activity runtime's diagnostic channel so they land in the desktop log.
function reportDesktopQueuedPromptDrainerDiagnostic(
  runtime: AgentActivityRuntime,
  event: string,
  details: Record<string, unknown>
): void {
  const reportDiagnostic = runtime.reportDiagnostic;
  if (!reportDiagnostic) {
    return;
  }
  try {
    void Promise.resolve(
      reportDiagnostic.call(runtime, {
        details,
        event: `agent.gui.queued_prompt_drain.${event}`,
        level: desktopQueuedPromptDrainerDiagnosticLevel(event),
        source: "agent-gui",
        workspaceId:
          typeof details.workspaceId === "string"
            ? details.workspaceId
            : undefined
      })
    ).catch(() => {});
  } catch {
    // Diagnostic logging must never affect queue draining.
  }
}

function desktopQueuedPromptDrainerDiagnosticLevel(
  event: string
): "debug" | "info" | "warn" {
  if (event === "send-error" || event === "send-next-interrupt-error") {
    return "warn";
  }
  if (event === "scan") {
    return "debug";
  }
  return "info";
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
