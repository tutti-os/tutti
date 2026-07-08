import { describe, expect, it } from "vitest";
import {
  resolveComposerQueuedSendDisposition,
  resolveComposerSubmitPolicy,
  sessionIsOccupied,
  shouldHoldPromptInLocalQueue,
  type ComposerSubmitPolicyInput
} from "./composerSubmitPolicy";

function openGatesInput(
  overrides: Partial<ComposerSubmitPolicyInput> = {}
): ComposerSubmitPolicyInput {
  return {
    hasActiveConversation: true,
    liveState: "active",
    activeConversationCreatePending: false,
    isCreatingConversation: false,
    resumeUnavailable: false,
    occupancy: {
      displayStatusBusy: false,
      hasPendingSubmittedTurn: false,
      submitBlocked: false,
      conversationStatusBusy: false
    },
    pendingInteractive: false,
    isSubmitting: false,
    isInterrupting: false,
    approvalPending: false,
    interactivePromptPending: false,
    authRequired: false,
    providerTargetsLoading: false,
    selectedProviderTargetDisabled: false,
    gatewayNotReady: false,
    ...overrides
  };
}

describe("sessionIsOccupied", () => {
  it("treats any one occupancy signal as occupied, since each can lag alone", () => {
    expect(
      sessionIsOccupied({
        displayStatusBusy: false,
        hasPendingSubmittedTurn: false,
        submitBlocked: false,
        conversationStatusBusy: false
      })
    ).toBe(false);
    expect(
      sessionIsOccupied({
        displayStatusBusy: true,
        hasPendingSubmittedTurn: false,
        submitBlocked: false,
        conversationStatusBusy: false
      })
    ).toBe(true);
    expect(
      sessionIsOccupied({
        displayStatusBusy: false,
        hasPendingSubmittedTurn: true,
        submitBlocked: false,
        conversationStatusBusy: false
      })
    ).toBe(true);
    expect(
      sessionIsOccupied({
        displayStatusBusy: false,
        hasPendingSubmittedTurn: false,
        submitBlocked: true,
        conversationStatusBusy: false
      })
    ).toBe(true);
    expect(
      sessionIsOccupied({
        displayStatusBusy: false,
        hasPendingSubmittedTurn: false,
        submitBlocked: false,
        conversationStatusBusy: true
      })
    ).toBe(true);
  });
});

describe("resolveComposerSubmitPolicy", () => {
  it("submits directly when every gate is open and the session is free", () => {
    const policy = resolveComposerSubmitPolicy(openGatesInput());
    expect(policy).toEqual({
      sessionOccupied: false,
      canSubmit: true,
      canQueueWhileBusy: false,
      disposition: "submit"
    });
  });

  it("queues while a live turn blocks the direct path", () => {
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({
        occupancy: {
          displayStatusBusy: false,
          hasPendingSubmittedTurn: false,
          submitBlocked: true,
          conversationStatusBusy: false
        }
      })
    );
    expect(policy.canSubmit).toBe(false);
    expect(policy.canQueueWhileBusy).toBe(true);
    expect(policy.disposition).toBe("queue");
  });

  it("queues while a local submit is still in flight", () => {
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({ isSubmitting: true })
    );
    expect(policy.canSubmit).toBe(false);
    expect(policy.disposition).toBe("queue");
  });

  it("queues while the session waits on an interactive prompt", () => {
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({ pendingInteractive: true })
    );
    expect(policy.canQueueWhileBusy).toBe(true);
    expect(policy.disposition).toBe("queue");
  });

  it("prefers the queue when both paths are open (busy display status only)", () => {
    // Display-status busy alone does not close canSubmit (only the derived
    // submitBlocked does), but a busy signal means a direct submit would
    // race the daemon's single-active-turn slot — the queue must win.
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({
        occupancy: {
          displayStatusBusy: true,
          hasPendingSubmittedTurn: false,
          submitBlocked: false,
          conversationStatusBusy: false
        }
      })
    );
    expect(policy.canSubmit).toBe(true);
    expect(policy.canQueueWhileBusy).toBe(true);
    expect(policy.disposition).toBe("queue");
  });

  it("never queues without an active conversation", () => {
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({
        hasActiveConversation: false,
        isSubmitting: true
      })
    );
    expect(policy.canQueueWhileBusy).toBe(false);
    expect(policy.disposition).toBe("blocked");
  });

  it.each([
    ["providerTargetsLoading", { providerTargetsLoading: true }],
    ["liveState activating", { liveState: "activating" as const }],
    ["liveState failed", { liveState: "failed" as const }],
    ["resumeUnavailable", { resumeUnavailable: true }],
    ["gatewayNotReady", { gatewayNotReady: true }],
    ["approvalPending", { approvalPending: true }],
    ["interactivePromptPending", { interactivePromptPending: true }],
    ["authRequired", { authRequired: true }],
    ["isCreatingConversation", { isCreatingConversation: true }],
    ["isInterrupting", { isInterrupting: true }]
  ])(
    "blocks the direct path when %s",
    (_label, overrides: Partial<ComposerSubmitPolicyInput>) => {
      const policy = resolveComposerSubmitPolicy(openGatesInput(overrides));
      expect(policy.canSubmit).toBe(false);
    }
  );

  it("blocks a home-composer send when the selected provider target is disabled", () => {
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({
        hasActiveConversation: false,
        selectedProviderTargetDisabled: true
      })
    );
    expect(policy.canSubmit).toBe(false);
    expect(policy.disposition).toBe("blocked");
  });

  it("ignores a disabled provider target once a conversation is active", () => {
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({ selectedProviderTargetDisabled: true })
    );
    expect(policy.canSubmit).toBe(true);
  });

  it("queues during the pre-activation create window instead of blocking", () => {
    // First-message create: the conversation is entered optimistically and
    // no backend session exists yet, so no occupancy signal fires. The
    // create-pending marker keeps the queue path open — the send is held
    // locally and drained once the session activates and its first turn
    // settles.
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({
        liveState: "activating",
        activeConversationCreatePending: true,
        isCreatingConversation: true
      })
    );
    expect(policy.canSubmit).toBe(false);
    expect(policy.canQueueWhileBusy).toBe(true);
    expect(policy.disposition).toBe("queue");
  });

  it("keeps a resume activation (no create pending) blocked", () => {
    // Reconnecting to an existing session shows the recovery banner and
    // stays blocked; only the first-message create window queues.
    const policy = resolveComposerSubmitPolicy(
      openGatesInput({ liveState: "activating" })
    );
    expect(policy.canSubmit).toBe(false);
    expect(policy.canQueueWhileBusy).toBe(false);
    expect(policy.disposition).toBe("blocked");
  });
});

describe("shouldHoldPromptInLocalQueue", () => {
  it("dispatches directly when nothing holds the prompt", () => {
    expect(
      shouldHoldPromptInLocalQueue({
        commandInFlight: false,
        hasPendingSubmittedTurn: false,
        pendingInteractive: false,
        displayStatusBusy: false,
        sessionCreatePending: false,
        submitBlocked: false,
        conversationStatusBusy: false
      })
    ).toBe(false);
  });

  it.each([
    ["commandInFlight", { commandInFlight: true }],
    ["hasPendingSubmittedTurn", { hasPendingSubmittedTurn: true }],
    ["pendingInteractive", { pendingInteractive: true }],
    ["displayStatusBusy", { displayStatusBusy: true }],
    ["sessionCreatePending", { sessionCreatePending: true }],
    ["submitBlocked", { submitBlocked: true }],
    ["conversationStatusBusy", { conversationStatusBusy: true }]
  ])("holds the prompt when %s", (_label, overrides) => {
    expect(
      shouldHoldPromptInLocalQueue({
        commandInFlight: false,
        hasPendingSubmittedTurn: false,
        pendingInteractive: false,
        displayStatusBusy: false,
        sessionCreatePending: false,
        submitBlocked: false,
        conversationStatusBusy: false,
        ...overrides
      })
    ).toBe(true);
  });
});

describe("resolveComposerQueuedSendDisposition", () => {
  it("sends directly then resumes when a stop left the queue suspended and the session is free", () => {
    expect(
      resolveComposerQueuedSendDisposition({
        shouldHoldInLocalQueue: false,
        hasQueuedPrompts: true,
        queueSuspended: true
      })
    ).toBe("direct_then_resume");
  });

  it("enqueues behind an actively drainable queue so the send cannot race drain", () => {
    expect(
      resolveComposerQueuedSendDisposition({
        shouldHoldInLocalQueue: false,
        hasQueuedPrompts: true,
        queueSuspended: false
      })
    ).toBe("enqueue");
  });

  it("enqueues while the session is still occupied", () => {
    expect(
      resolveComposerQueuedSendDisposition({
        shouldHoldInLocalQueue: true,
        hasQueuedPrompts: true,
        queueSuspended: true
      })
    ).toBe("enqueue");
    expect(
      resolveComposerQueuedSendDisposition({
        shouldHoldInLocalQueue: true,
        hasQueuedPrompts: false,
        queueSuspended: false
      })
    ).toBe("enqueue");
  });

  it("returns null when neither hold nor queue applies", () => {
    expect(
      resolveComposerQueuedSendDisposition({
        shouldHoldInLocalQueue: false,
        hasQueuedPrompts: false,
        queueSuspended: false
      })
    ).toBeNull();
  });
});
