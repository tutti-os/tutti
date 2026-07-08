/**
 * The composer answers one business question: "what happens when the user
 * presses send right now?" There are exactly three answers:
 *
 * - `"submit"`: every gate is open and the session is free — the prompt is
 *   sent to the daemon immediately and starts a turn.
 * - `"queue"`: the session is occupied (live turn, unconfirmed local submit,
 *   busy display status, or an interactive prompt in flight) — the prompt is
 *   still accepted, but it is held in the local queue
 *   (`AgentQueuedPromptRuntime`) and dispatched by the drain coordinator when
 *   the session frees up.
 * - `"blocked"`: sending is impossible or meaningless right now (provider not
 *   ready, activation failed, approval/auth pending, ...) — the composer
 *   disables the send action.
 *
 * Historically this decision was assembled from boolean expressions scattered
 * across the controller (`canSubmit`, `canQueueWhileBusy`), the dispatch path
 * (`shouldQueuePromptLocally`), and view-level recombinations
 * (`submitDisabled`, `composerDisabled`). The copies drifted and hid the
 * product rule; this module is the single home for it. The controller feeds
 * it named inputs and consumes named outputs — no caller should re-derive
 * pieces of this truth table locally.
 */

/**
 * What the active session is doing right now, as far as sending is concerned.
 * These three signals arrive on different channels with different latencies,
 * which is why all of them participate: any one of them alone can be stale.
 */
export interface ComposerSessionOccupancy {
  /**
   * The runtime display status projects the session as running/queued/
   * waiting. Wire-derived; can lag behind a just-submitted turn.
   */
  displayStatusBusy: boolean;
  /**
   * A prompt was submitted locally and its turn has not been confirmed on
   * the wire yet (optimistic pending turn). Local; covers the wire lag above.
   */
  hasPendingSubmittedTurn: boolean;
  /**
   * The turn-lifecycle-derived submitAvailability is blocked (ADR 0008 —
   * derived locally from the lifecycle, not trusted from the wire copy).
   * This is the signal that closes the direct-submit path during a live
   * turn so it cannot race the daemon's single-active-turn slot.
   */
  submitBlocked: boolean;
}

/**
 * The session cannot take a direct submit right now; a new prompt has to
 * wait for the current work to settle.
 */
export function sessionIsOccupied(
  occupancy: ComposerSessionOccupancy
): boolean {
  return (
    occupancy.displayStatusBusy ||
    occupancy.hasPendingSubmittedTurn ||
    occupancy.submitBlocked
  );
}

export interface ComposerSubmitPolicyInput {
  /** A conversation is selected (including an optimistic pre-activation entry). */
  hasActiveConversation: boolean;
  /** Activation state of the active conversation's live session. */
  liveState: "inactive" | "activating" | "active" | "failed";
  /**
   * The active conversation is an optimistic first-message create whose
   * backend session does not exist yet (pre-activation window). Sends stay
   * possible here — they queue and drain once the session activates. If the
   * activation fails, the queued prompts are restored into the home draft.
   */
  activeConversationCreatePending: boolean;
  /** A conversation create is in flight anywhere on this node. */
  isCreatingConversation: boolean;
  /** The conversation needs a resume but the session is not resumable here. */
  resumeUnavailable: boolean;
  occupancy: ComposerSessionOccupancy;
  /** The session is waiting on an interactive prompt reply. */
  pendingInteractive: boolean;
  /** A submit command is currently in flight from this composer. */
  isSubmitting: boolean;
  /** An interrupt (stop) command is currently in flight. */
  isInterrupting: boolean;
  /** The session is waiting on the user to answer an approval. */
  approvalPending: boolean;
  /** The session is waiting on the user to answer an interactive prompt. */
  interactivePromptPending: boolean;
  /** The session requires authentication before it can take input. */
  authRequired: boolean;
  /** Provider targets are still loading; there is nothing to send to yet. */
  providerTargetsLoading: boolean;
  /** No conversation is selected and the selected provider target is disabled. */
  selectedProviderTargetDisabled: boolean;
  /** The provider routes through a gateway that is not ready (openclaw). */
  gatewayNotReady: boolean;
}

export type ComposerSendDisposition = "submit" | "queue" | "blocked";

export interface ComposerSubmitPolicy {
  /** The session cannot take a direct submit; see {@link sessionIsOccupied}. */
  sessionOccupied: boolean;
  /** The direct-submit path is open: send starts a turn immediately. */
  canSubmit: boolean;
  /**
   * The queue path is open: send is accepted and held locally until the
   * drain coordinator dispatches it. When both paths are open the composer
   * prefers the queue (a busy signal means a direct submit would race).
   */
  canQueueWhileBusy: boolean;
  /** The single-word answer to "what happens if the user presses send". */
  disposition: ComposerSendDisposition;
}

export function resolveComposerSubmitPolicy(
  input: ComposerSubmitPolicyInput
): ComposerSubmitPolicy {
  const sessionOccupied = sessionIsOccupied(input.occupancy);
  const canSubmit =
    !input.providerTargetsLoading &&
    input.liveState !== "activating" &&
    input.liveState !== "failed" &&
    !input.resumeUnavailable &&
    (input.hasActiveConversation || !input.selectedProviderTargetDisabled) &&
    !input.gatewayNotReady &&
    !input.approvalPending &&
    !input.interactivePromptPending &&
    !input.authRequired &&
    !input.isCreatingConversation &&
    !input.isSubmitting &&
    !input.isInterrupting &&
    !input.occupancy.submitBlocked;
  const canQueueWhileBusy =
    input.hasActiveConversation &&
    (sessionOccupied ||
      input.isSubmitting ||
      input.pendingInteractive ||
      input.activeConversationCreatePending);
  return {
    sessionOccupied,
    canSubmit,
    canQueueWhileBusy,
    disposition: canQueueWhileBusy ? "queue" : canSubmit ? "submit" : "blocked"
  };
}

/**
 * Dispatch-time twin of the policy above: `submitExistingPrompt` asks this
 * right before sending, per target session (which is not always the active
 * conversation — e.g. a recovered session id). A `true` answer means "hold
 * the prompt in the local queue instead of calling the daemon now".
 *
 * This must stay consistent with the `"queue"` disposition: if the composer
 * accepted a send because the queue path was open, the dispatch decision must
 * actually queue it — a drift between the two is how prompts end up racing
 * the daemon's single-active-turn slot.
 */
export interface HoldPromptInLocalQueueInput {
  /** A submit or approval response from this composer is still in flight. */
  commandInFlight: boolean;
  /** See {@link ComposerSessionOccupancy.hasPendingSubmittedTurn}. */
  hasPendingSubmittedTurn: boolean;
  /** See {@link ComposerSubmitPolicyInput.pendingInteractive}. */
  pendingInteractive: boolean;
  /** See {@link ComposerSessionOccupancy.displayStatusBusy}. */
  displayStatusBusy: boolean;
  /**
   * The target session is an optimistic create whose activation is still in
   * flight — there is no daemon session to send to yet, so the prompt must
   * wait in the queue for the drain coordinator.
   */
  sessionCreatePending: boolean;
}

export function shouldHoldPromptInLocalQueue(
  input: HoldPromptInLocalQueueInput
): boolean {
  return (
    input.commandInFlight ||
    input.hasPendingSubmittedTurn ||
    input.pendingInteractive ||
    input.displayStatusBusy ||
    input.sessionCreatePending
  );
}
