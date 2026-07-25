import { resolvePendingSubmission } from "./pendingSubmission";

describe("resolvePendingSubmission", () => {
  it("reuses the exact identity when retrying an existing session submission", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionId: "session-1",
      agentTargetId: null,
      creating: false,
      text: "continue"
    });

    expect(
      resolvePendingSubmission(first, {
        agentSessionId: "session-1",
        agentTargetId: "ignored-for-existing-session",
        creating: false,
        text: "continue"
      })
    ).toBe(first);
  });

  it("reuses both session and submit identity when retrying session creation", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionId: null,
      agentTargetId: "target-1",
      creating: true,
      text: "start"
    });
    const retry = resolvePendingSubmission(first, {
      agentSessionId: null,
      agentTargetId: "target-1",
      creating: true,
      text: "start"
    });

    expect(retry).toBe(first);
    expect(retry.agentSessionId).not.toBe("");
    expect(retry.clientSubmitId).not.toBe("");
  });

  it("creates a new identity after the submission content changes", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionId: "session-1",
      agentTargetId: null,
      creating: false,
      text: "first"
    });
    const changed = resolvePendingSubmission(first, {
      agentSessionId: "session-1",
      agentTargetId: null,
      creating: false,
      text: "second"
    });

    expect(changed).not.toBe(first);
    expect(changed.clientSubmitId).not.toBe(first.clientSubmitId);
  });

  it("does not reuse an identity across sessions", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionId: "session-1",
      agentTargetId: null,
      creating: false,
      text: "continue"
    });
    const otherSession = resolvePendingSubmission(first, {
      agentSessionId: "session-2",
      agentTargetId: null,
      creating: false,
      text: "continue"
    });

    expect(otherSession).not.toBe(first);
    expect(otherSession.agentSessionId).toBe("session-2");
  });
});
