import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentActivityAdapter } from "./adapter.ts";
import { createAgentActivityController } from "./controller.ts";
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
      role: "assistant",
      kind: "ask_user_question",
      status: "waiting",
      payload: { title: "Pick one" }
    }
  });

  assert.equal(controller.getSnapshot().sessions.length, 1);
  assert.equal(
    controller.getSnapshot().sessionMessagesById["session-1"]?.[0]?.messageId,
    "message-1"
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
      role: "assistant",
      kind: "ask_user_question",
      status: "waiting",
      payload: { title: "Fresh live message" }
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

test("controller caches composer options by provider and clones snapshots", async () => {
  let loadCount = 0;
  const controller = createAgentActivityController({
    adapter: fakeAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
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

  const first = await controller.loadComposerOptions({ provider: "codex" });
  first.models[0]!.label = "mutated";
  first.permissionConfig!.defaultValue = "mutated";
  first.permissionConfig!.modes[0]!.label = "mutated";
  (first.runtimeContext!.promptCapabilities as Record<string, unknown>).image =
    false;
  const second = await controller.loadComposerOptions({ provider: "codex" });

  assert.equal(loadCount, 1);
  assert.equal(second.models[0]?.label, "GPT-5.4");
  assert.equal(second.permissionConfig?.defaultValue, "auto");
  assert.equal(second.permissionConfig?.modes[0]?.label, "Auto");
  assert.deepEqual(second.runtimeContext?.promptCapabilities, { image: true });
  assert.equal(
    controller.getSnapshot().composerOptionsByProvider?.codex?.models[0]?.label,
    "GPT-5.4"
  );
  assert.equal(
    controller.getSnapshot().composerOptionsByProvider?.codex?.permissionConfig
      ?.defaultValue,
    "auto"
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

  const firstLoad = controller.loadComposerOptions({ provider: "codex" });
  const secondLoad = controller.loadComposerOptions({ provider: "codex" });
  (releaseLoad as (() => void) | null)?.();
  const [first, second] = await Promise.all([firstLoad, secondLoad]);

  assert.equal(loadCount, 1);
  assert.equal(first.models[0]?.value, "gpt-1");
  assert.equal(second.models[0]?.value, "gpt-1");

  const reload = controller.loadComposerOptions({
    provider: "codex",
    force: true
  });
  (releaseLoad as (() => void) | null)?.();
  const reloaded = await reload;

  assert.equal(loadCount, 2);
  assert.equal(reloaded.models[0]?.value, "gpt-2");
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

  const staleLoad = controller.loadComposerOptions({ provider: "codex" });
  await waitFor(() => {
    assert.equal(resolvers.length, 1);
  });

  const forceLoad = controller.loadComposerOptions({
    provider: "codex",
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
    controller.getSnapshot().composerOptionsByProvider?.codex?.models[0]?.value,
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
    cwd: "/repo/a"
  });
  const cachedSame = await controller.loadComposerOptions({
    provider: "codex",
    cwd: "/repo/a"
  });
  assert.equal(adapterCalls.length, 1); // same cwd → cache hit
  const afterSwitch = await controller.loadComposerOptions({
    provider: "codex",
    cwd: "/repo/b"
  });
  assert.equal(adapterCalls.length, 2); // cwd changed → refetch
  assert.equal(adapterCalls[1]?.cwd, "/repo/b");
  void first;
  void cachedSame;
  void afterSwitch;
});

function fakeAdapter(
  overrides: {
    listSessions?: AgentActivityAdapter["listSessions"];
    listSessionMessages?: AgentActivityAdapter["listSessionMessages"];
    loadComposerOptions?: AgentActivityAdapter["loadComposerOptions"];
    subscribe?: AgentActivityAdapter["subscribeSessionEvents"];
  } = {}
): AgentActivityAdapter {
  return {
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
    subscribeSessionEvents:
      overrides.subscribe ??
      (() => {
        return Promise.resolve(() => {});
      }),
    createSession: async (input) => ({
      workspaceId: input.workspaceId,
      agentSessionId: "session-1",
      provider: input.provider,
      cwd: input.cwd ?? "",
      title: input.title ?? "",
      status: "working"
    }),
    sendInput: async (input) => ({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      provider: "codex",
      cwd: "",
      title: "",
      status: "working"
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
    deleteSession: async () => ({ removed: true })
  };
}

function createComposerOptions(
  overrides: Partial<AgentActivityComposerOptions> = {}
): AgentActivityComposerOptions {
  return {
    provider: "codex",
    models: [],
    reasoningEfforts: [],
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
    role: "assistant",
    kind: "ask_user_question",
    status: "waiting",
    payload: { title: "Prompt" },
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
