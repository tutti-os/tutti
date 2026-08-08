import { parseAgentLiveDeliveries } from "./agentLiveNativeBridge";

describe("parseAgentLiveDeliveries", () => {
  test("maps ready, event, and scoped discontinuity deliveries", () => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: {
            accepted: [
              { kind: "stream_ready" },
              {
                event: {
                  agentSessionId: "session-1",
                  data: {
                    agentSessionId: "session-1",
                    eventType: "session_audit",
                    workspaceId: "workspace-1"
                  },
                  eventType: "session_audit",
                  workspaceId: "workspace-1"
                },
                kind: "event"
              },
              {
                discontinuity: {
                  reason: "sequence_gap",
                  reconcileKeys: [
                    {
                      agentSessionId: "session-1",
                      kind: "session",
                      workspaceId: "workspace-1"
                    }
                  ]
                },
                kind: "discontinuity"
              }
            ]
          },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      { kind: "connection", status: "connected" },
      {
        event: expect.objectContaining({
          agentSessionId: "session-1",
          eventType: "session_audit",
          workspaceId: "workspace-1"
        }),
        kind: "event"
      },
      {
        kind: "discontinuity",
        reason: "sequence_gap",
        reconcileKeys: [
          {
            agentSessionId: "session-1",
            kind: "session",
            workspaceId: "workspace-1"
          }
        ]
      }
    ]);
  });

  test("maps disconnect and rejects deliveries for another workspace", () => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          reason: "stream_closed",
          status: "disconnected",
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        kind: "connection",
        reason: "stream_closed",
        retryable: true,
        status: "disconnected"
      }
    ]);
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: { accepted: [{ kind: "stream_ready" }] },
          subscriptionGeneration: 7,
          workspaceId: "workspace-2"
        })
      )
    ).toEqual([]);
  });

  test("preserves a protocol rejection as a terminal connection failure", () => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: {
            accepted: [
              {
                kind: "rejected",
                rejected: {
                  expectedRevision: "sha256:new",
                  reason: "protocol_revision_mismatch",
                  receivedRevision: "sha256:old"
                }
              }
            ]
          },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        expectedRevision: "sha256:new",
        kind: "connection",
        reason: "protocol_revision_mismatch",
        receivedRevision: "sha256:old",
        retryable: false,
        status: "disconnected"
      }
    ]);
  });

  test("rejects queued deliveries from an obsolete native subscription", () => {
    const delivery = JSON.stringify({
      result: { accepted: [{ kind: "stream_ready" }] },
      subscriptionGeneration: 6,
      workspaceId: "workspace-1"
    });

    expect(parseAgentLiveDeliveries("workspace-1", 7, delivery)).toEqual([]);
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: { accepted: [{ kind: "stream_ready" }] },
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([]);
  });

  test("preserves canonical session deletion as a typed delivery", () => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: {
            accepted: [
              {
                discontinuity: {
                  reason: "session_deleted",
                  reconcileKeys: [
                    {
                      agentSessionId: "session-1",
                      kind: "session",
                      workspaceId: "workspace-1"
                    }
                  ]
                },
                kind: "discontinuity"
              }
            ],
            reconcileRequired: true
          },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        agentSessionId: "session-1",
        kind: "session_deleted"
      }
    ]);
  });

  test("preserves canonical session restore as a typed delivery", () => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: {
            accepted: [
              {
                discontinuity: {
                  reason: "session_restored",
                  reconcileKeys: [
                    {
                      agentSessionId: "session-1",
                      kind: "session",
                      workspaceId: "workspace-1"
                    }
                  ]
                },
                kind: "discontinuity"
              }
            ],
            reconcileRequired: true
          },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        agentSessionId: "session-1",
        kind: "session_restored"
      }
    ]);
  });

  test("preserves typed attachment recovery controls", () => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: {
            accepted: [
              {
                attachmentChanged: {
                  agentSessionId: " session-1 ",
                  attachmentRevision: 3,
                  bindingId: " binding-1 ",
                  callerTurnId: " caller-turn-1 ",
                  canonicalTurnId: " canonical-turn-1 ",
                  workspaceId: " workspace-1 "
                },
                kind: "attachment_changed"
              },
              {
                attachmentCaughtUp: {
                  agentSessionId: "session-1",
                  attachmentRevision: 3,
                  bindingId: "binding-1",
                  callerTurnId: "caller-turn-1",
                  canonicalTurnId: "canonical-turn-1",
                  workspaceId: "workspace-1"
                },
                kind: "attachment_caught_up"
              }
            ]
          },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        attachment: {
          agentSessionId: "session-1",
          attachmentRevision: 3,
          bindingId: "binding-1",
          callerTurnId: "caller-turn-1",
          canonicalTurnId: "canonical-turn-1",
          workspaceId: "workspace-1"
        },
        kind: "attachment_changed"
      },
      {
        attachment: {
          agentSessionId: "session-1",
          attachmentRevision: 3,
          bindingId: "binding-1",
          callerTurnId: "caller-turn-1",
          canonicalTurnId: "canonical-turn-1",
          workspaceId: "workspace-1"
        },
        kind: "attachment_caught_up"
      }
    ]);
  });

  test.each([
    {
      attachmentChanged: {
        agentSessionId: "session-1",
        attachmentRevision: 0,
        bindingId: "binding-1",
        workspaceId: "workspace-1"
      },
      kind: "attachment_changed"
    },
    {
      attachmentCaughtUp: {
        agentSessionId: "session-1",
        attachmentRevision: 1,
        bindingId: "binding-1",
        canonicalTurnId: "canonical-turn-1",
        workspaceId: "workspace-1"
      },
      kind: "attachment_caught_up"
    }
  ])("reconciles malformed attachment control %#", (accepted) => {
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: { accepted: [accepted] },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        kind: "discontinuity",
        reason: "invalid_attachment_control",
        reconcileKeys: []
      }
    ]);
  });

  test("turns invalid or unknown native deliveries into reconciliation", () => {
    expect(parseAgentLiveDeliveries("workspace-1", 7, "{")).toEqual([
      {
        kind: "discontinuity",
        reason: "invalid_native_delivery",
        reconcileKeys: []
      }
    ]);
    expect(
      parseAgentLiveDeliveries(
        "workspace-1",
        7,
        JSON.stringify({
          result: { accepted: [{ kind: "future_delivery" }] },
          subscriptionGeneration: 7,
          workspaceId: "workspace-1"
        })
      )
    ).toEqual([
      {
        kind: "discontinuity",
        reason: "unknown_delivery",
        reconcileKeys: []
      }
    ]);
  });
});
