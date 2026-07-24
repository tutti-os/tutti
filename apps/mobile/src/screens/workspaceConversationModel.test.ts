import { resolvePendingSubmission } from "./workspaceConversationModel";

describe("resolvePendingSubmission", () => {
  it("reuses the exact identity when retrying an existing session submission", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionID: "session-1",
      agentTargetID: null,
      creating: false,
      text: "continue"
    });

    expect(
      resolvePendingSubmission(first, {
        agentSessionID: "session-1",
        agentTargetID: "ignored-for-existing-session",
        creating: false,
        text: "continue"
      })
    ).toBe(first);
  });

  it("reuses both session and submit identity when retrying session creation", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionID: null,
      agentTargetID: "target-1",
      creating: true,
      text: "start"
    });
    const retry = resolvePendingSubmission(first, {
      agentSessionID: null,
      agentTargetID: "target-1",
      creating: true,
      text: "start"
    });

    expect(retry).toBe(first);
    expect(retry.agentSessionID).not.toBe("");
    expect(retry.clientSubmitID).not.toBe("");
  });

  it("creates a new identity after the submission content changes", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionID: "session-1",
      agentTargetID: null,
      creating: false,
      text: "first"
    });
    const changed = resolvePendingSubmission(first, {
      agentSessionID: "session-1",
      agentTargetID: null,
      creating: false,
      text: "second"
    });

    expect(changed).not.toBe(first);
    expect(changed.clientSubmitID).not.toBe(first.clientSubmitID);
  });

  it("does not reuse an identity across sessions", () => {
    const first = resolvePendingSubmission(null, {
      agentSessionID: "session-1",
      agentTargetID: null,
      creating: false,
      text: "continue"
    });
    const otherSession = resolvePendingSubmission(first, {
      agentSessionID: "session-2",
      agentTargetID: null,
      creating: false,
      text: "continue"
    });

    expect(otherSession).not.toBe(first);
    expect(otherSession.agentSessionID).toBe("session-2");
  });
});
