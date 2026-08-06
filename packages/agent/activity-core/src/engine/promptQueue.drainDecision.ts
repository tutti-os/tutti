import type {
  CanonicalSessionLifecycleView,
  CanonicalSubmitAvailability
} from "./sessionLifecycle.availability.ts";
import type { PromptQueueRecord } from "./promptQueue.types.ts";

export function isSettingsUpdateBlockingDrain(
  lifecycle: CanonicalSessionLifecycleView,
  agentSessionId: string
): boolean {
  const status =
    lifecycle.operationBySessionId[agentSessionId]?.settingsUpdate.status;
  return (
    status === "inFlight" ||
    status === "waitingForRuntime" ||
    status === "unknown" ||
    status === "failed"
  );
}

export function activeTurnIdForSession(
  lifecycle: CanonicalSessionLifecycleView,
  rawAgentSessionId: string
): string | undefined {
  return lifecycle.sessionsById[rawAgentSessionId.trim()]?.activeTurnId?.trim();
}

export type QueueDrainDecision =
  | {
      kind: "blocked";
      reason:
        | "no_head"
        | "in_flight"
        | "uncertain_delivery"
        | "suspended"
        | "failed_head"
        | "settings_update_pending"
        | "barrier_pending"
        | "unavailable";
    }
  | { kind: "send"; guidance: boolean };

/**
 * Decides whether a queue's head prompt is ready to drain and, if so,
 * whether it goes out as a plain new-turn submit or as a guidance steer into
 * the active turn. This is the ONLY place that decision is made: every
 * current and future blocker joins this single ordered list rather than
 * gating drain from a separate, independent pre-check.
 *
 * The order below is the contract; earlier rules win:
 *
 *  1. no head prompt queued
 *  2. a send is already in flight
 *  3. the previous send's delivery is uncertain (timed out, exact turn unknown)
 *  4. the queue is suspended (explicit user stop)
 *  5. the head previously failed and hasn't been retried
 *  6. a user/activation settings write is still unsettled (not waitingForPromptSend)
 *  7. the head is guidance steering the turn availability is blocked on
 *  8. the delivery barrier (from the last accepted send) hasn't settled
 *  9. availability is otherwise not available
 * 10. otherwise the head is ready to send as a plain new-turn submit
 *
 * Guidance (rule 7) is deliberately ABOVE the delivery barrier (rule 8). The
 * barrier only serializes NEW-TURN sends against each other, so the daemon
 * never sees two competing turn starts for the same session. A guidance head
 * steers the very turn the barrier is tracking — making it wait for that
 * turn to settle first would deadlock the queue, since the entire point of
 * guidance is to reach the turn while it is still running. Guidance may
 * steer that turn repeatedly (each successive promotion re-runs this same
 * decision); a guidance send never touches the barrier, which stays in place
 * to serialize the next plain prompt behind the turn it is still tracking.
 *
 * Settings (rule 6) serializes composer menu / activation settings writes with
 * the next user send so UpdateSettings and Send never race the daemon session
 * settings lock. `waitingForPromptSend` is excluded: that state means a prompt
 * precondition already succeeded and the owning send must proceed next.
 */
export function resolveQueueDrainDecision(
  record: PromptQueueRecord,
  availability: CanonicalSubmitAvailability,
  barrierPending: boolean,
  settingsUpdatePending = false
): QueueDrainDecision {
  const head = record.prompts[0];
  if (!head) {
    return { kind: "blocked", reason: "no_head" };
  }
  if (record.inFlight) {
    return { kind: "blocked", reason: "in_flight" };
  }
  if (record.uncertainDelivery) {
    return { kind: "blocked", reason: "uncertain_delivery" };
  }
  if (record.suspendReason) {
    return { kind: "blocked", reason: "suspended" };
  }
  if (record.failedPromptId === head.id) {
    return { kind: "blocked", reason: "failed_head" };
  }
  if (settingsUpdatePending) {
    return { kind: "blocked", reason: "settings_update_pending" };
  }
  if (
    head.guidance === true &&
    availability.state === "blocked" &&
    availability.reason === "active_turn"
  ) {
    return { kind: "send", guidance: true };
  }
  if (barrierPending) {
    return { kind: "blocked", reason: "barrier_pending" };
  }
  if (availability.state !== "available") {
    return { kind: "blocked", reason: "unavailable" };
  }
  return { kind: "send", guidance: false };
}
