import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentActivityAdapter } from "./adapter.ts";
import {
  createAgentActivityController,
  setAgentActivityStoreDiagnosticSink
} from "./controller.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivityMessage,
  AgentActivityMessagePage,
  AgentActivitySession,
  AgentActivitySessionEventEnvelope,
  AgentActivitySessionList
} from "./types.ts";

test("controller loads sessions and merges live message events", async () => {
  let liveEvent:
    | ((event: AgentActivitySessionEventEnvelope) => void)
    | undefined;
  const adapter = fakeAdapter({
    subscribe(input) {
      liveEvent = (event) => input.onEvent(event);
      return Promise.resolve(() => {});
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();
  controller.retainSessionEvents({ agentSessionId: "session-1" });
  liveEvent?.({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      messageId: "message-1",
      version: 1,
      turnId: "turn-1",
      role: "assistant",
      kind: "ask_user_question",
      status: "waiting",
      payload: { title: "Pick one" },
      occurredAtUnixMs: 1000
    }
  });

  assert.equal(controller.getSnapshot().sessions.length, 1);
  assert.equal(
    controller.getSnapshot().sessionMessagesById["session-1"]?.[0]?.messageId,
    "message-1"
  );
});

test("controller ignores unnormalized live message events", async () => {
  let liveEvent:
    | ((event: AgentActivitySessionEventEnvelope) => void)
    | undefined;
  const adapter = fakeAdapter({
    subscribe(input) {
      liveEvent = (event) => input.onEvent(event);
      return Promise.resolve(() => {});
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();
  controller.retainSessionEvents({ agentSessionId: "session-1" });
  liveEvent?.({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      messageId: "message-without-turn",
      version: 1,
      role: "assistant",
      kind: "text",
      payload: { text: "old event" }
    }
  });

  assert.equal(
    controller.getSnapshot().sessionMessagesById["session-1"],
    undefined
  );
});

test("controller snapshot reference is stable until data changes", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });
  const initialSnapshot = controller.getSnapshot();
  const notifications: unknown[] = [];
  const unsubscribe = controller.subscribe((snapshot) => {
    notifications.push(snapshot);
  });

  assert.equal(controller.getSnapshot(), initialSnapshot);
  assert.equal(notifications[0], initialSnapshot);

  await controller.listSessionMessages({ agentSessionId: "session-1" });
  assert.equal(controller.getSnapshot(), initialSnapshot);

  await controller.load();
  const loadedSnapshot = controller.getSnapshot();
  assert.notEqual(loadedSnapshot, initialSnapshot);
  assert.equal(controller.getSnapshot(), loadedSnapshot);

  unsubscribe();
});

test("controller rejects stale session upserts after newer activity state", () => {
  const diagnostics: Array<{
    details: Record<string, unknown>;
    event: string;
  }> = [];
  setAgentActivityStoreDiagnosticSink((event, details) => {
    diagnostics.push({ event, details });
  });
  try {
    const controller = createAgentActivityController({
      adapter: fakeAdapter(),
      workspaceId: "workspace-1"
    });
    controller.upsertSession(
      createSession({
        status: "completed",
        updatedAtUnixMs: 2000,
        turnLifecycle: {
          activeTurnId: null,
          phase: "settled",
          outcome: "completed"
        },
        submitAvailability: { state: "available" }
      })
    );
    controller.upsertSession(
      createSession({
        status: "working",
        updatedAtUnixMs: 1000,
        turnLifecycle: { activeTurnId: "turn-1", phase: "running" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      })
    );

    const session = controller.getSnapshot().sessions[0];
    assert.equal(session?.status, "completed");
    assert.equal(session?.turnLifecycle?.phase, "settled");
    assert.equal(session?.submitAvailability?.state, "available");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.event, "session_version_regression");
    assert.equal(diagnostics[0]?.details.previousKey, 2000);
    assert.equal(diagnostics[0]?.details.nextKey, 1000);
  } finally {
    setAgentActivityStoreDiagnosticSink(null);
  }
});

test("controller can list session messages without caching them", async () => {
  const adapter = fakeAdapter({
    listSessionMessages: () =>
      Promise.resolve({
        hasMore: false,
        latestVersion: 5,
        messages: [
          createMessage({
            messageId: "message-5",
            version: 5,
            payload: { text: "latest" }
          })
        ]
      })
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.listSessionMessages({
    agentSessionId: "session-1",
    cache: false
  });
  assert.equal(
    controller.getSnapshot().sessionMessagesById["session-1"],
    undefined
  );

  await controller.listSessionMessages({ agentSessionId: "session-1" });
  assert.deepEqual(
    controller
      .getSnapshot()
      .sessionMessagesById["session-1"]?.map((message) => message.version),
    [5]
  );
});

test("controller does not notify subscribers when loaded sessions are unchanged", async () => {
  let currentSession = createSession();
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [{ ...currentSession }]
        })
    }),
    workspaceId: "workspace-1"
  });
  let notificationCount = 0;
  controller.subscribe(() => {
    notificationCount += 1;
  });

  await controller.load();
  const loadedSnapshot = controller.getSnapshot();
  assert.equal(notificationCount, 2);

  await controller.load();
  assert.equal(controller.getSnapshot(), loadedSnapshot);
  assert.equal(notificationCount, 2);

  currentSession = createSession({ title: "Renamed session" });
  await controller.load();
  assert.equal(notificationCount, 3);
  assert.equal(controller.getSnapshot().sessions[0]?.title, "Renamed session");
});

test("controller does not notify subscribers when upserted sessions are unchanged", () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });
  let notificationCount = 0;
  controller.subscribe(() => {
    notificationCount += 1;
  });

  const session = createSession({
    currentPhase: "working",
    lastEventUnixMs: 2000,
    submitAvailability: { state: "blocked", reason: "active_turn" },
    turnLifecycle: {
      activeTurnId: "turn-1",
      phase: "running",
      outcome: null
    },
    updatedAtUnixMs: 2000
  });
  controller.upsertSession(session);
  const snapshotAfterFirstUpsert = controller.getSnapshot();
  assert.equal(notificationCount, 2);

  controller.upsertSession({
    ...session,
    submitAvailability: { state: "blocked", reason: "active_turn" },
    turnLifecycle: {
      activeTurnId: "turn-1",
      phase: "running",
      outcome: null
    }
  });
  assert.equal(controller.getSnapshot(), snapshotAfterFirstUpsert);
  assert.equal(notificationCount, 2);

  controller.upsertSession({
    ...session,
    lastEventUnixMs: 3000,
    status: "completed",
    submitAvailability: { state: "available" },
    turnLifecycle: {
      activeTurnId: null,
      phase: "settled",
      outcome: "completed"
    },
    updatedAtUnixMs: 3000
  });
  assert.equal(notificationCount, 3);
  assert.equal(controller.getSnapshot().sessions[0]?.status, "completed");
});

test("controller retains one stream for multiple consumers", async () => {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const adapter = fakeAdapter({
    subscribe() {
      subscribeCount += 1;
      return Promise.resolve(() => {
        unsubscribeCount += 1;
      });
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  const releaseA = controller.retainSessionEvents({
    agentSessionId: "session-1"
  });
  const releaseB = controller.retainSessionEvents({
    agentSessionId: "session-1"
  });
  releaseA();
  releaseA();
  await Promise.resolve();
  assert.equal(subscribeCount, 1);
  assert.equal(unsubscribeCount, 0);
  releaseB();
  await Promise.resolve();
  assert.equal(unsubscribeCount, 1);
});

test("controller preserves cached messages when loading sessions", async () => {
  const adapter = fakeAdapter({
    listSessions: () =>
      Promise.resolve({
        presences: [
          {
            id: "presence-1",
            workspaceId: "workspace-1",
            provider: "codex",
            status: "working"
          }
        ],
        sessions: [
          createSession({
            title: "Loaded from sessions endpoint",
            messageVersion: 2
          })
        ]
      }),
    listSessionMessages: () =>
      Promise.resolve({
        hasMore: false,
        latestVersion: 2,
        messages: [
          createMessage({
            messageId: "message-1",
            version: 2,
            payload: { title: "Cached prompt" }
          })
        ]
      })
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.listSessionMessages({ agentSessionId: "session-1" });
  await controller.load();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.presences[0]?.id, "presence-1");
  assert.equal(snapshot.sessions[0]?.title, "Loaded from sessions endpoint");
  assert.equal(
    snapshot.sessionMessagesById["session-1"]?.[0]?.payload.title,
    "Cached prompt"
  );
});

test("controller quietly syncs active sessions discovered during load", async () => {
  const messageRequests: Array<{
    afterVersion?: number;
    agentSessionId: string;
  }> = [];
  const subscribeRequests: Array<{
    afterVersion?: number;
    agentSessionId: string;
  }> = [];
  const adapter = fakeAdapter({
    listSessions: () =>
      Promise.resolve({
        sessions: [
          createSession({
            agentSessionId: "session-1",
            messageVersion: 4,
            status: "working"
          })
        ]
      }),
    listSessionMessages: (input) => {
      messageRequests.push({
        afterVersion: input.afterVersion,
        agentSessionId: input.agentSessionId
      });
      return Promise.resolve({
        hasMore: false,
        latestVersion: 4,
        messages: [
          createMessage({
            messageId: "message-4",
            version: 4,
            payload: { text: "restored" }
          })
        ]
      });
    },
    subscribe(input) {
      subscribeRequests.push({
        afterVersion: input.afterVersion,
        agentSessionId: input.agentSessionId
      });
      return Promise.resolve(() => {});
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();

  await waitFor(() => {
    assert.deepEqual(subscribeRequests, [
      { afterVersion: 0, agentSessionId: "session-1" }
    ]);
    assert.deepEqual(messageRequests, [
      { afterVersion: 0, agentSessionId: "session-1" }
    ]);
    assert.equal(
      controller.getSnapshot().sessionMessagesById["session-1"]?.[0]?.payload
        .text,
      "restored"
    );
  });
});

test("controller quietly syncs every active session message page", async () => {
  const messageRequests: number[] = [];
  const pages = new Map([
    [
      0,
      {
        hasMore: true,
        latestVersion: 1,
        messages: [
          createMessage({
            messageId: "message-1",
            version: 1,
            payload: { text: "first page" }
          })
        ]
      }
    ],
    [
      1,
      {
        hasMore: true,
        latestVersion: 2,
        messages: [
          createMessage({
            messageId: "message-2",
            version: 2,
            payload: { text: "second page" }
          })
        ]
      }
    ],
    [
      2,
      {
        hasMore: false,
        latestVersion: 3,
        messages: [
          createMessage({
            messageId: "message-3",
            version: 3,
            payload: { text: "last page" }
          })
        ]
      }
    ]
  ]);
  const adapter = fakeAdapter({
    listSessions: () =>
      Promise.resolve({
        sessions: [
          createSession({
            agentSessionId: "session-1",
            messageVersion: 3,
            status: "working"
          })
        ]
      }),
    listSessionMessages: (input) => {
      const afterVersion = input.afterVersion ?? 0;
      messageRequests.push(afterVersion);
      const page = pages.get(afterVersion);
      assert.ok(page, `unexpected afterVersion ${afterVersion}`);
      return Promise.resolve(page);
    },
    subscribe: () => Promise.resolve(() => {})
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();

  await waitFor(() => {
    assert.deepEqual(messageRequests, [0, 1, 2]);
    assert.deepEqual(
      controller
        .getSnapshot()
        .sessionMessagesById["session-1"]?.map((message) => message.version),
      [1, 2, 3]
    );
  });
});

test("controller uses latestVersion to continue paged active session sync", async () => {
  const messageRequests: number[] = [];
  const adapter = fakeAdapter({
    listSessions: () =>
      Promise.resolve({
        sessions: [
          createSession({
            agentSessionId: "session-1",
            messageVersion: 3,
            status: "working"
          })
        ]
      }),
    listSessionMessages: (input) => {
      const afterVersion = input.afterVersion ?? 0;
      messageRequests.push(afterVersion);
      if (afterVersion === 0) {
        return Promise.resolve({
          hasMore: true,
          latestVersion: 2,
          messages: [
            createMessage({
              messageId: "message-1",
              version: 1,
              payload: { text: "first page" }
            })
          ]
        });
      }
      assert.equal(afterVersion, 2);
      return Promise.resolve({
        hasMore: false,
        latestVersion: 3,
        messages: [
          createMessage({
            messageId: "message-3",
            version: 3,
            payload: { text: "last page" }
          })
        ]
      });
    },
    subscribe: () => Promise.resolve(() => {})
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();

  await waitFor(() => {
    assert.deepEqual(messageRequests, [0, 2]);
    assert.deepEqual(
      controller
        .getSnapshot()
        .sessionMessagesById["session-1"]?.map((message) => message.version),
      [1, 3]
    );
  });
});

test("controller releases automatically retained streams when sessions become terminal", async () => {
  let currentSessions = [
    createSession({
      agentSessionId: "session-1",
      status: "working"
    })
  ];
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const adapter = fakeAdapter({
    listSessions: () => Promise.resolve({ sessions: currentSessions }),
    subscribe() {
      subscribeCount += 1;
      return Promise.resolve(() => {
        unsubscribeCount += 1;
      });
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();
  await controller.load();
  await waitFor(() => {
    assert.equal(subscribeCount, 1);
  });

  currentSessions = [
    createSession({
      agentSessionId: "session-1",
      status: "completed"
    })
  ];
  await controller.load();

  await waitFor(() => {
    assert.equal(unsubscribeCount, 1);
  });
});

test("controller retries automatic retained streams after subscribe failure", async () => {
  let subscribeCount = 0;
  const adapter = fakeAdapter({
    listSessions: () =>
      Promise.resolve({
        sessions: [
          createSession({
            agentSessionId: "session-1",
            status: "working"
          })
        ]
      }),
    subscribe() {
      subscribeCount += 1;
      return Promise.reject(new Error("subscribe failed"));
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.load();
  await waitFor(() => {
    assert.equal(subscribeCount, 1);
  });

  await controller.load();
  await waitFor(() => {
    assert.equal(subscribeCount, 2);
  });
});

test("controller keeps newer live messages over stale listed messages", async () => {
  let liveEvent:
    | ((event: AgentActivitySessionEventEnvelope) => void)
    | undefined;
  const adapter = fakeAdapter({
    listSessionMessages: () =>
      Promise.resolve({
        hasMore: false,
        latestVersion: 1,
        messages: [
          createMessage({
            messageId: "message-1",
            version: 1,
            payload: { title: "Stale listed message" }
          })
        ]
      }),
    subscribe(input) {
      liveEvent = (event) => input.onEvent(event);
      return Promise.resolve(() => {});
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  controller.retainSessionEvents({ agentSessionId: "session-1" });
  liveEvent?.({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      messageId: "message-1",
      version: 2,
      turnId: "turn-1",
      role: "assistant",
      kind: "ask_user_question",
      status: "waiting",
      payload: { title: "Fresh live message" },
      occurredAtUnixMs: 2000
    }
  });
  await controller.listSessionMessages({ agentSessionId: "session-1" });

  const message =
    controller.getSnapshot().sessionMessagesById["session-1"]?.[0];
  assert.equal(message?.version, 2);
  assert.equal(message?.payload.title, "Fresh live message");
});

test("controller handles duplicate inline activity updates without notifying subscribers", () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });
  let notificationCount = 0;
  controller.subscribe(() => {
    notificationCount += 1;
  });

  const message = createMessage({
    payload: { parts: [{ text: "Pick one" }], title: "Prompt" }
  });
  const firstResult = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: { messages: [message] }
  });
  assert.equal(firstResult.applied, true);
  assert.equal(firstResult.messages.length, 1);
  assert.equal(notificationCount, 2);
  const snapshotAfterFirstUpdate = controller.getSnapshot();

  const duplicateResult = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: { messages: [{ ...message, payload: { ...message.payload } }] }
  });
  assert.equal(duplicateResult.applied, true);
  assert.equal(duplicateResult.messages.length, 0);
  assert.equal(controller.getSnapshot(), snapshotAfterFirstUpdate);
  assert.equal(notificationCount, 2);

  const changedResult = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: {
      messages: [
        {
          ...message,
          payload: { ...message.payload, title: "Updated prompt" }
        }
      ]
    }
  });
  assert.equal(changedResult.applied, true);
  assert.equal(changedResult.messages.length, 1);
  assert.equal(notificationCount, 3);
});

test("controller canonicalizes provider-session message updates to the agent session", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              agentSessionId: "session-1",
              providerSessionId: "provider-1"
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "provider-1",
    eventType: "message_update",
    data: {
      messages: [
        createMessage({
          agentSessionId: "provider-1",
          messageId: "approval-1",
          kind: "approval.requested",
          status: "waiting_approval",
          payload: { callType: "approval" }
        })
      ]
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.messages[0]?.agentSessionId, "session-1");
  assert.equal(
    controller.getSnapshot().sessionMessagesById["session-1"]?.[0]
      ?.agentSessionId,
    "session-1"
  );
  assert.equal(
    controller.getSnapshot().sessionMessagesById["provider-1"],
    undefined
  );
});

test("controller accepts canonical inline messages before alias metadata loads", () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });

  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "provider-1",
    eventType: "message_update",
    data: {
      messages: [
        createMessage({
          agentSessionId: "session-1",
          messageId: "approval-1",
          kind: "approval.requested",
          status: "waiting_approval",
          payload: { callType: "approval" }
        })
      ]
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.messages[0]?.agentSessionId, "session-1");
  assert.equal(
    controller.getSnapshot().sessionMessagesById["session-1"]?.[0]?.messageId,
    "approval-1"
  );
  assert.equal(
    controller.getSnapshot().sessionMessagesById["provider-1"],
    undefined
  );
});

test("controller migrates provider-session message buckets when session metadata arrives", () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });

  controller.applySessionEvent({
    workspaceId: "workspace-1",
    agentSessionId: "provider-1",
    eventType: "message_update",
    data: createMessage({
      agentSessionId: "provider-1",
      messageId: "approval-1",
      kind: "approval.requested",
      status: "waiting_approval",
      payload: { callType: "approval" }
    })
  });
  assert.equal(
    controller.getSnapshot().sessionMessagesById["provider-1"]?.[0]?.messageId,
    "approval-1"
  );

  controller.applySessionEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "session_update",
    data: createSession({
      agentSessionId: "session-1",
      providerSessionId: "provider-1"
    })
  });

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.sessionMessagesById["provider-1"], undefined);
  assert.equal(
    snapshot.sessionMessagesById["session-1"]?.[0]?.agentSessionId,
    "session-1"
  );
  assert.equal(
    snapshot.sessionMessagesById["session-1"]?.[0]?.messageId,
    "approval-1"
  );
});

test("controller does not canonicalize ambiguous provider-session message buckets", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              agentSessionId: "runtime-session",
              providerSessionId: "provider-1"
            }),
            createSession({
              agentSessionId: "hook-session",
              providerSessionId: "provider-1"
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "provider-1",
    eventType: "message_update",
    data: {
      messages: [
        createMessage({
          agentSessionId: "provider-1",
          messageId: "message-ambiguous"
        })
      ]
    }
  });

  const snapshot = controller.getSnapshot();
  assert.equal(
    snapshot.sessionMessagesById["provider-1"]?.[0]?.messageId,
    "message-ambiguous"
  );
  assert.equal(snapshot.sessionMessagesById["runtime-session"], undefined);
  assert.equal(snapshot.sessionMessagesById["hook-session"], undefined);
});

test("controller canonicalizes provider-session state patches to the agent session", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              agentSessionId: "session-1",
              providerSessionId: "provider-1",
              status: "working",
              updatedAtUnixMs: 100
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "provider-1",
    eventType: "state_patch",
    data: {
      agentSessionId: "provider-1",
      providerSessionId: "provider-1",
      lifecycleStatus: "completed",
      occurredAtUnixMs: 200
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.statePatch?.agentSessionId, "session-1");
  assert.equal(
    controller.getSnapshot().sessions[0]?.agentSessionId,
    "session-1"
  );
  assert.equal(controller.getSnapshot().sessions[0]?.status, "completed");
});

test("controller preserves runtime context from inline state patches", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              agentSessionId: "session-1",
              status: "working",
              updatedAtUnixMs: 100
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  const runtimeContext = {
    usage: {
      contextWindow: {
        usedTokens: 38660,
        totalTokens: 1000000
      }
    }
  };
  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      agentSessionId: "session-1",
      occurredAtUnixMs: 200,
      runtimeContext
    }
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.statePatch?.runtimeContext, runtimeContext);
  assert.deepEqual(
    controller.getSnapshot().sessions[0]?.runtimeContext,
    runtimeContext
  );
});

test("controller preserves pending interactive prompts from inline state patches", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              agentSessionId: "session-1",
              status: "working",
              updatedAtUnixMs: 100
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      agentSessionId: "session-1",
      occurredAtUnixMs: 200,
      pendingInteractive: {
        kind: "ask-user",
        requestId: "request-1",
        toolName: "AskUserQuestion",
        status: "waiting",
        input: { questions: [{ id: "scope", question: "Scope?" }] }
      }
    }
  });

  assert.equal(result.applied, true);
  assert.deepEqual(controller.getSnapshot().sessions[0]?.pendingInteractive, {
    kind: "ask-user",
    requestId: "request-1",
    toolName: "AskUserQuestion",
    status: "waiting",
    input: { questions: [{ id: "scope", question: "Scope?" }] }
  });

  controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      agentSessionId: "session-1",
      occurredAtUnixMs: 201,
      pendingInteractive: null
    }
  });

  assert.equal(controller.getSnapshot().sessions[0]?.pendingInteractive, null);
});

test("controller keeps existing agent target id when state patch omits it", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              agentSessionId: "session-1",
              agentTargetId: "local:codex",
              status: "working",
              updatedAtUnixMs: 100
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      agentSessionId: "session-1",
      occurredAtUnixMs: 200,
      lifecycleStatus: "completed"
    }
  });

  assert.equal(
    controller.getSnapshot().sessions[0]?.agentTargetId,
    "local:codex"
  );
});

test("controller uses cached latest message version when retaining events", async () => {
  let retainedAfterVersion: number | undefined;
  const adapter = fakeAdapter({
    listSessionMessages: () =>
      Promise.resolve({
        hasMore: false,
        latestVersion: 7,
        messages: [
          createMessage({ messageId: "message-1", version: 3 }),
          createMessage({ messageId: "message-2", version: 7 })
        ]
      }),
    subscribe(input) {
      retainedAfterVersion = input.afterVersion;
      return Promise.resolve(() => {});
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  await controller.listSessionMessages({ agentSessionId: "session-1" });
  controller.retainSessionEvents({ agentSessionId: "session-1" });

  assert.equal(retainedAfterVersion, 7);
});

test("controller cleans failed retained streams so callers can retry", async () => {
  const errors: unknown[] = [];
  let subscribeCount = 0;
  const adapter = fakeAdapter({
    subscribe() {
      subscribeCount += 1;
      return Promise.reject(new Error("subscribe failed"));
    }
  });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  const release = controller.retainSessionEvents({
    agentSessionId: "session-1",
    onError: (error) => errors.push(error)
  });
  await waitFor(() => {
    assert.equal(errors.length, 1);
  });
  release();

  controller.retainSessionEvents({
    agentSessionId: "session-1",
    onError: (error) => errors.push(error)
  });
  await waitFor(() => {
    assert.equal(subscribeCount, 2);
    assert.equal(errors.length, 2);
  });
});

test("controller no-ops retained streams when adapter does not support session event subscriptions", async () => {
  const adapter = fakeAdapter({ omitSubscribe: true });
  const controller = createAgentActivityController({
    adapter,
    workspaceId: "workspace-1"
  });

  const release = controller.retainSessionEvents({
    agentSessionId: "session-1",
    onError(error) {
      throw error;
    }
  });
  release();

  await controller.load();

  assert.equal(controller.getSnapshot().sessions.length, 1);
});

test("controller does not auto-retain loaded sessions when auto retention is disabled", async () => {
  const messageRequests: Array<{
    afterVersion?: number;
    agentSessionId: string;
  }> = [];
  const adapter = fakeAdapter({
    omitSubscribe: true,
    listSessions: () =>
      Promise.resolve({
        sessions: [
          createSession({
            agentSessionId: "session-1",
            messageVersion: 4,
            status: "working"
          })
        ]
      }),
    listSessionMessages(input) {
      messageRequests.push({
        afterVersion: input.afterVersion,
        agentSessionId: input.agentSessionId
      });
      return Promise.resolve({
        hasMore: false,
        latestVersion: 4,
        messages: []
      });
    }
  });
  const controller = createAgentActivityController({
    adapter,
    autoRetainSessionEvents: false,
    workspaceId: "workspace-1"
  });

  await controller.load();
  await Promise.resolve();

  assert.deepEqual(messageRequests, []);
});

test("controller ignores events for other workspaces", () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });

  controller.applySessionEvent({
    workspaceId: "workspace-2",
    agentSessionId: "session-1",
    eventType: "session_update",
    data: createSession({ title: "Wrong workspace" })
  });
  controller.applySessionEvent({
    workspaceId: "workspace-2",
    agentSessionId: "session-1",
    eventType: "message_update",
    data: createMessage({ payload: { title: "Wrong workspace" } })
  });

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.sessions.length, 0);
  assert.deepEqual(snapshot.sessionMessagesById, {});
});

test("controller preserves inline state patch turn metadata", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });

  await controller.load();
  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "state_patch",
      lastEventUnixMs: 2000,
      turn: {
        turnId: "turn-1",
        phase: "completed",
        outcome: "success",
        fileChanges: { changed: ["src/app.ts"] },
        startedAtUnixMs: 1000,
        completedAtUnixMs: 2000
      }
    }
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.statePatch?.turn, {
    turnId: "turn-1",
    phase: "completed",
    outcome: "success",
    fileChanges: { changed: ["src/app.ts"] },
    startedAtUnixMs: 1000,
    completedAtUnixMs: 2000
  });
});

test("controller clears active turn and submit block from settled inline state patch", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              turnLifecycle: {
                activeTurnId: "turn-1",
                phase: "running",
                startedAtUnixMs: 1000
              },
              submitAvailability: {
                state: "blocked",
                reason: "active_turn"
              },
              currentPhase: "working",
              lastEventUnixMs: 1000,
              updatedAtUnixMs: 1000
            })
          ]
        })
    }),
    workspaceId: "workspace-1"
  });

  await controller.load();
  const result = controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "state_patch",
      currentPhase: "idle",
      lastEventUnixMs: 2000,
      submitAvailability: { state: "available" },
      turn: {
        turnId: "turn-1",
        activeTurnId: null,
        phase: "settled",
        outcome: "completed",
        submitAvailability: { state: "available" },
        startedAtUnixMs: 1000,
        completedAtUnixMs: 2000
      }
    }
  });

  assert.equal(result.applied, true);
  const session = controller.getSnapshot().sessions[0];
  assert.deepEqual(session?.turnLifecycle, {
    turnId: "turn-1",
    activeTurnId: null,
    phase: "settled",
    settling: undefined,
    startedAtUnixMs: 1000,
    completedAtUnixMs: 2000,
    outcome: "completed",
    completedCommand: null
  });
  assert.deepEqual(session?.submitAvailability, { state: "available" });
  assert.equal(session?.currentPhase, "idle");

  controller.applyActivityUpdatedEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    eventType: "state_patch",
    data: {
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      eventType: "state_patch",
      currentPhase: "idle",
      lastEventUnixMs: 2100,
      turn: {
        turnId: "turn-1",
        activeTurnId: null,
        phase: "settled",
        outcome: "completed"
      }
    }
  });

  assert.deepEqual(controller.getSnapshot().sessions[0]?.turnLifecycle, {
    turnId: "turn-1",
    activeTurnId: null,
    phase: "settled",
    settling: undefined,
    startedAtUnixMs: 1000,
    completedAtUnixMs: 2000,
    outcome: "completed",
    completedCommand: null
  });
});

test("controller maps session update events into complete session snapshots", () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });

  controller.applySessionEvent({
    workspaceId: "workspace-1",
    agentSessionId: "session-2",
    eventType: "session_update",
    data: {
      session: createSession({
        agentSessionId: "session-2",
        cwd: "/repo/two",
        providerSessionId: "provider-session-2",
        model: "gpt-5",
        status: "waiting",
        resumable: true,
        currentPhase: "asking",
        lastError: null,
        messageVersion: 8,
        lastEventUnixMs: 2000,
        startedAtUnixMs: 1000,
        endedAtUnixMs: undefined,
        createdAtUnixMs: 900,
        updatedAtUnixMs: 2000
      })
    }
  });

  const session = controller.getSnapshot().sessions[0];
  assert.equal(session?.agentSessionId, "session-2");
  assert.equal(session?.providerSessionId, "provider-session-2");
  assert.equal(session?.model, "gpt-5");
  assert.equal(session?.resumable, true);
  assert.equal(session?.messageVersion, 8);
  assert.equal(session?.lastEventUnixMs, 2000);
});

test("controller round-trips the opaque targetKey verbatim and clones snapshots", async () => {
  let loadCount = 0;
  const seenTargetKeys: Array<string | null | undefined> = [];
  const targetKey = "shared-agent:abc/def?weird=1";
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
        seenTargetKeys.push(input.agentTargetId);
        return createComposerOptions({
          provider: input.provider,
          models: [{ value: "gpt-5.4", label: "GPT-5.4" }],
          permissionConfig: {
            configurable: true,
            defaultValue: "auto",
            modes: [{ id: "auto", label: "Auto" }]
          },
          runtimeContext: { promptCapabilities: { image: true } }
        });
      }
    }),
    workspaceId: "workspace-1"
  });

  const first = await controller.loadComposerOptions({
    provider: "codex",
    targetKey
  });
  first.models[0]!.label = "mutated";
  first.permissionConfig!.defaultValue = "mutated";
  first.permissionConfig!.modes[0]!.label = "mutated";
  (first.runtimeContext!.promptCapabilities as Record<string, unknown>).image =
    false;
  const second = await controller.loadComposerOptions({
    provider: "codex",
    targetKey
  });

  assert.equal(loadCount, 1);
  // The key is round-tripped verbatim to the adapter and used as the snapshot
  // key without any parsing or prefixing.
  assert.deepEqual(seenTargetKeys, [targetKey]);
  assert.equal(second.models[0]?.label, "GPT-5.4");
  assert.equal(second.permissionConfig?.defaultValue, "auto");
  assert.equal(second.permissionConfig?.modes[0]?.label, "Auto");
  assert.deepEqual(second.runtimeContext?.promptCapabilities, { image: true });
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.[targetKey]?.models[0]
      ?.label,
    "GPT-5.4"
  );
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.[targetKey]
      ?.permissionConfig?.defaultValue,
    "auto"
  );
});

test("controller loadComposerOptions requires a non-empty targetKey", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter(),
    workspaceId: "workspace-1"
  });
  await assert.rejects(
    controller.loadComposerOptions({ provider: "codex", targetKey: "  " }),
    /targetKey is required/
  );
});

test("controller invalidateComposerOptions makes the next non-forced load refetch", async () => {
  let loadCount = 0;
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
        return createComposerOptions({
          provider: input.provider,
          models: [{ value: `model-${loadCount}`, label: `Model ${loadCount}` }]
        });
      }
    }),
    workspaceId: "workspace-1"
  });

  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  assert.equal(loadCount, 1);

  controller.invalidateComposerOptions({ providers: ["codex"] });
  // The stale snapshot stays available for rendering until the refetch lands.
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.["local:codex"]
      ?.models[0]?.value,
    "model-1"
  );
  const reloaded = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  assert.equal(loadCount, 2);
  assert.equal(reloaded.models[0]?.value, "model-2");
});

test("controller invalidateComposerOptions filters by cached provider, not by key", async () => {
  let loadCount = 0;
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
        return createComposerOptions({
          provider: input.provider,
          models: [{ value: `model-${loadCount}`, label: `Model ${loadCount}` }]
        });
      }
    }),
    workspaceId: "workspace-1"
  });

  // Two codex targets and one claude-code target — all in the single key space.
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  await controller.loadComposerOptions({
    provider: "claude-code",
    targetKey: "local:claude-code"
  });
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "shared-agent:codex-1"
  });
  assert.equal(loadCount, 3);

  controller.invalidateComposerOptions({ providers: ["codex"] });
  // claude-code target is untouched → cache hit.
  await controller.loadComposerOptions({
    provider: "claude-code",
    targetKey: "local:claude-code"
  });
  assert.equal(loadCount, 3);
  // Both codex targets refetch.
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "shared-agent:codex-1"
  });
  assert.equal(loadCount, 5);
});

test("controller isolates caches for two targetKeys sharing a provider", async () => {
  const adapterCalls: Array<{
    agentTargetId: string | null | undefined;
    provider: string;
  }> = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        adapterCalls.push({
          agentTargetId: input.agentTargetId,
          provider: input.provider
        });
        return createComposerOptions({
          provider: input.provider,
          models: [{ value: `${input.agentTargetId}-model`, label: "Model" }]
        });
      }
    }),
    workspaceId: "workspace-1"
  });

  // Same provider, two distinct targets (impersonation preview): the caches
  // must not merge into a single provider bucket.
  const targetA = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "target-a"
  });
  const targetB = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "target-b"
  });
  const targetAAgain = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "target-a"
  });

  assert.equal(adapterCalls.length, 2);
  assert.deepEqual(adapterCalls, [
    { agentTargetId: "target-a", provider: "codex" },
    { agentTargetId: "target-b", provider: "codex" }
  ]);
  assert.equal(targetA.models[0]?.value, "target-a-model");
  assert.equal(targetB.models[0]?.value, "target-b-model");
  assert.equal(targetAAgain.models[0]?.value, "target-a-model");
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.["target-a"]?.models[0]
      ?.value,
    "target-a-model"
  );
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.["target-b"]?.models[0]
      ?.value,
    "target-b-model"
  );
});

test("controller dedupes in-flight composer option loads and supports force reload", async () => {
  let loadCount = 0;
  let releaseLoad: (() => void) | null = null;
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        return createComposerOptions({
          provider: input.provider,
          models: [{ value: `gpt-${loadCount}`, label: `GPT-${loadCount}` }]
        });
      }
    }),
    workspaceId: "workspace-1"
  });

  const firstLoad = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  const secondLoad = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  (releaseLoad as (() => void) | null)?.();
  const [first, second] = await Promise.all([firstLoad, secondLoad]);

  assert.equal(loadCount, 1);
  assert.equal(first.models[0]?.value, "gpt-1");
  assert.equal(second.models[0]?.value, "gpt-1");

  const reload = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    force: true
  });
  (releaseLoad as (() => void) | null)?.();
  const reloaded = await reload;

  assert.equal(loadCount, 2);
  assert.equal(reloaded.models[0]?.value, "gpt-2");
});

test("controller in-flight dedup is scoped per targetKey", async () => {
  let loadCount = 0;
  const releases: Array<() => void> = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return createComposerOptions({
          provider: input.provider,
          models: [{ value: `${input.agentTargetId}-model`, label: "Model" }]
        });
      }
    }),
    workspaceId: "workspace-1"
  });

  // Concurrent loads on distinct targetKeys must not dedup into one another.
  const loadA = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "target-a"
  });
  const loadB = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "target-b"
  });
  await waitFor(() => {
    assert.equal(loadCount, 2);
  });
  for (const release of releases) {
    release();
  }
  const [a, b] = await Promise.all([loadA, loadB]);
  assert.equal(a.models[0]?.value, "target-a-model");
  assert.equal(b.models[0]?.value, "target-b-model");
});

test("controller force reload bypasses stale in-flight composer option loads", async () => {
  const resolvers: Array<(options: AgentActivityComposerOptions) => void> = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) =>
        new Promise<AgentActivityComposerOptions>((resolve) => {
          resolvers.push((options) =>
            resolve(
              createComposerOptions({
                ...options,
                provider: input.provider
              })
            )
          );
        })
    }),
    workspaceId: "workspace-1"
  });

  const staleLoad = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  await waitFor(() => {
    assert.equal(resolvers.length, 1);
  });

  const forceLoad = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    force: true
  });
  await waitFor(() => {
    assert.equal(resolvers.length, 2);
  });

  resolvers[1]?.(
    createComposerOptions({
      provider: "codex",
      models: [{ value: "fresh", label: "Fresh" }]
    })
  );
  const fresh = await forceLoad;
  assert.equal(fresh.models[0]?.value, "fresh");

  resolvers[0]?.(
    createComposerOptions({
      provider: "codex",
      models: [{ value: "stale", label: "Stale" }]
    })
  );
  const stale = await staleLoad;

  assert.equal(stale.models[0]?.value, "stale");
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.["local:codex"]
      ?.models[0]?.value,
    "fresh"
  );
});

test("loadComposerOptions refetches when cwd changes and caches per cwd", async () => {
  const adapterCalls: Array<{
    provider: string;
    cwd: string | null | undefined;
  }> = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        adapterCalls.push({ provider: input.provider, cwd: input.cwd });
        return createComposerOptions({ provider: input.provider });
      }
    }),
    workspaceId: "workspace-1"
  });

  const first = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    cwd: "/repo/a"
  });
  const cachedSame = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    cwd: "/repo/a"
  });
  assert.equal(adapterCalls.length, 1); // same cwd → cache hit
  const afterSwitch = await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    cwd: "/repo/b"
  });
  assert.equal(adapterCalls.length, 2); // cwd changed → refetch
  assert.equal(adapterCalls[1]?.cwd, "/repo/b");
  void first;
  void cachedSame;
  void afterSwitch;
});

test("loadComposerOptions refetches when composer settings change", async () => {
  const requestedModels: Array<string | null | undefined> = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        requestedModels.push(input.settings?.model);
        return createComposerOptions({ provider: input.provider });
      }
    }),
    workspaceId: "workspace-1"
  });

  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "gpt-5.6-sol" }
  });
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "gpt-5.6-sol" }
  });
  await controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "gpt-5.6-luna" }
  });

  assert.deepEqual(requestedModels, ["gpt-5.6-sol", "gpt-5.6-luna"]);
});

test("loadComposerOptions refetches when an agent target switches provider", async () => {
  const requestedProviders: string[] = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        requestedProviders.push(input.provider);
        return createComposerOptions({ provider: input.provider });
      }
    }),
    workspaceId: "workspace-1"
  });

  await controller.loadComposerOptions({
    targetKey: "shared-target",
    provider: "codex"
  });
  await controller.loadComposerOptions({
    targetKey: "shared-target",
    provider: "claude-code"
  });

  assert.deepEqual(requestedProviders, ["codex", "claude-code"]);
});

test("invalidateComposerOptions keeps an in-flight load stale", async () => {
  const resolvers: Array<(options: AgentActivityComposerOptions) => void> = [];
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async () =>
        new Promise<AgentActivityComposerOptions>((resolve) => {
          resolvers.push(resolve);
        })
    }),
    workspaceId: "workspace-1"
  });

  const staleLoad = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  await waitFor(() => assert.equal(resolvers.length, 1));
  controller.invalidateComposerOptions({ providers: ["codex"] });
  const freshLoad = controller.loadComposerOptions({
    provider: "codex",
    targetKey: "local:codex"
  });
  await waitFor(() => assert.equal(resolvers.length, 2));

  resolvers[0]?.(
    createComposerOptions({
      models: [{ value: "stale", label: "Stale" }]
    })
  );
  await staleLoad;
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.["local:codex"],
    undefined
  );

  resolvers[1]?.(
    createComposerOptions({
      models: [{ value: "fresh", label: "Fresh" }]
    })
  );
  await freshLoad;
  assert.equal(
    controller.getSnapshot().composerOptionsByTargetKey?.["local:codex"]
      ?.models[0]?.value,
    "fresh"
  );
});

function fakeAdapter(
  overrides: {
    listSessions?: AgentActivityAdapter["listSessions"];
    listSessionMessages?: AgentActivityAdapter["listSessionMessages"];
    loadComposerOptions?: AgentActivityAdapter["loadComposerOptions"];
    omitSubscribe?: boolean;
    subscribe?: NonNullable<AgentActivityAdapter["subscribeSessionEvents"]>;
  } = {}
): AgentActivityAdapter {
  const adapter: AgentActivityAdapter = {
    listSessions:
      overrides.listSessions ??
      (() =>
        Promise.resolve({
          sessions: [createSession()]
        } satisfies AgentActivitySessionList)),
    listSessionMessages:
      overrides.listSessionMessages ??
      (() =>
        Promise.resolve({
          hasMore: false,
          latestVersion: 0,
          messages: [] as AgentActivityMessage[]
        } satisfies AgentActivityMessagePage)),
    loadComposerOptions:
      overrides.loadComposerOptions ??
      ((input) => Promise.resolve(createComposerOptions(input))),
    createSession: async (input) => ({
      workspaceId: input.workspaceId,
      agentSessionId: "session-1",
      provider: "codex",
      cwd: input.cwd ?? "",
      title: input.title ?? "",
      status: "working"
    }),
    sendInput: async (input) => ({
      session: {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        provider: "codex",
        cwd: "",
        title: "",
        status: "working"
      },
      turnId: "turn-1",
      turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
      submitAvailability: { state: "blocked", reason: "active_turn" }
    }),
    cancelSession: async (input) => ({
      canceled: true,
      reason: "active_turn_canceled",
      session: {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        provider: "codex",
        cwd: "",
        title: "",
        status: "canceled"
      }
    }),
    submitInteractive: async () => ({}),
    goalControl: async (input) => ({
      goal: null,
      session: {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        provider: "codex",
        cwd: "",
        title: "",
        status: "ready"
      }
    }),
    renameSession: async (input) => ({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      provider: "codex",
      cwd: "",
      title: input.title,
      status: "ready"
    }),
    deleteSession: async () => ({ removed: true })
  };
  if (!overrides.omitSubscribe) {
    adapter.subscribeSessionEvents =
      overrides.subscribe ??
      (() => {
        return Promise.resolve(() => {});
      });
  }
  return adapter;
}

function createComposerOptions(
  overrides: Partial<AgentActivityComposerOptions> = {}
): AgentActivityComposerOptions {
  return {
    provider: "codex",
    models: [],
    reasoningEfforts: [],
    speeds: [],
    permissionConfig: null,
    skills: [],
    loadedAtUnixMs: 1000,
    ...overrides
  };
}

function createSession(
  overrides: Partial<AgentActivitySession> = {}
): AgentActivitySession {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    cwd: "/repo",
    title: "Session",
    status: "working",
    ...overrides
  };
}

function createMessage(
  overrides: Partial<AgentActivityMessage> = {}
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 1,
    turnId: "turn-1",
    role: "assistant",
    kind: "ask_user_question",
    status: "waiting",
    payload: { title: "Prompt" },
    occurredAtUnixMs: 1000,
    ...overrides
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | undefined;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (lastError) {
    throw lastError;
  }
}

test("stale session upsert does not regress a fresher pushed state", async () => {
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () =>
        Promise.resolve({
          sessions: [
            createSession({
              turnLifecycle: { phase: "running", activeTurnId: "turn-1" },
              updatedAtUnixMs: 1000
            })
          ]
        } satisfies AgentActivitySessionList)
    }),
    workspaceId: "workspace-1"
  });
  await controller.load();

  // Fresher settled state lands (e.g. from a pushed state patch).
  controller.upsertSession(
    createSession({
      turnLifecycle: { phase: "settled", activeTurnId: null },
      updatedAtUnixMs: 2000
    })
  );
  // A reconcile fetch that resolved late carries a stale running view; it
  // must not overwrite the settled state (the session would freeze busy).
  controller.upsertSession(
    createSession({
      turnLifecycle: { phase: "running", activeTurnId: "turn-1" },
      updatedAtUnixMs: 1500
    })
  );

  const session = controller
    .getSnapshot()
    .sessions.find((item) => item.agentSessionId === "session-1");
  assert.equal(session?.turnLifecycle?.phase, "settled");
  assert.equal(session?.updatedAtUnixMs, 2000);
});

test("load keeps sessions that are fresher than the list response", async () => {
  let listCalls = 0;
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      listSessions: () => {
        listCalls += 1;
        return Promise.resolve({
          sessions: [
            createSession({
              turnLifecycle:
                listCalls === 1
                  ? { phase: "settled", activeTurnId: null }
                  : { phase: "running", activeTurnId: "turn-1" },
              updatedAtUnixMs: listCalls === 1 ? 2000 : 1500
            })
          ]
        } satisfies AgentActivitySessionList);
      }
    }),
    workspaceId: "workspace-1"
  });

  await controller.load();
  // Second load returns a stale point-in-time snapshot (e.g. an in-flight
  // request that resolved after a fresher push already landed).
  await controller.load();

  const session = controller
    .getSnapshot()
    .sessions.find((item) => item.agentSessionId === "session-1");
  assert.equal(session?.turnLifecycle?.phase, "settled");
  assert.equal(session?.updatedAtUnixMs, 2000);
});
