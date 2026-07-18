import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopPreferencesStateResponse,
  TuttidEventStreamClient,
  TuttidClient,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";
import { defaultDesktopWorkbenchShortcuts } from "../../../../../../../shared/preferences/index.ts";
import { createDesktopPreferencesClient } from "./desktopPreferencesClient.ts";

test("desktop preferences client resolves writes from the authoritative event", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );

  const completion = client.updateDesktopPreferences(createUpdateRequest());

  assert.deepEqual(eventStreamClient.publishedIntents, [
    {
      payload: createUpdateRequest(),
      topic: "preferences.desktop.update.requested"
    }
  ]);

  eventStreamClient.emitDesktopPreferencesUpdated(createStateResponse());

  assert.deepEqual(await completion, createPreferences());

  client.dispose();
});

test("desktop preferences client patches target defaults through the dedicated acknowledged intent", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );

  await client.patchAgentComposerDefaultsForTarget({
    agentTargetId: "local:opencode",
    clientMutationId: "mutation-1",
    patch: { permissionModeId: "full-access" }
  });

  assert.deepEqual(eventStreamClient.publishedIntents, [
    {
      payload: {
        agentTargetId: "local:opencode",
        clientMutationId: "mutation-1",
        patch: { permissionModeId: "full-access" }
      },
      topic: "preferences.agent.composer.defaults.patch.requested"
    }
  ]);
  client.dispose();
});

test("desktop preferences client accepts legacy dock layout responses for unified writes", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );

  const completion = client.updateDesktopPreferences(createUpdateRequest());

  eventStreamClient.emitDesktopPreferencesUpdated(
    createStateResponse({
      agentDockLayout: "legacySplit"
    })
  );

  assert.deepEqual(
    await completion,
    createPreferences({
      agentDockLayout: "legacySplit"
    })
  );

  client.dispose();
});

test("desktop preferences client distinguishes agent GUI conversation rail preference writes", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );

  const completion = client.updateDesktopPreferences(
    createUpdateRequest({
      agentGuiConversationRailCollapsedByProvider: {
        codex: true
      }
    })
  );
  let settled = false;
  void completion.then(() => {
    settled = true;
  });

  eventStreamClient.emitDesktopPreferencesUpdated(
    createStateResponse({
      agentGuiConversationRailCollapsedByProvider: {
        codex: false
      }
    })
  );
  await Promise.resolve();
  assert.equal(settled, false);

  eventStreamClient.emitDesktopPreferencesUpdated(
    createStateResponse({
      agentGuiConversationRailCollapsedByProvider: {
        codex: true
      }
    })
  );

  assert.deepEqual(
    await completion,
    createPreferences({
      agentGuiConversationRailCollapsedByProvider: {
        codex: true
      }
    })
  );

  client.dispose();
});

test("desktop preferences client does not gate full preference confirmation on target defaults snapshots", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );
  const completion = client.updateDesktopPreferences(
    createUpdateRequest({
      agentComposerDefaultsByAgentTarget: {
        "local:codex": { model: "stale-model" }
      },
      locale: "zh-CN"
    })
  );

  eventStreamClient.emitDesktopPreferencesUpdated(
    createStateResponse({
      agentComposerDefaultsByAgentTarget: {
        "local:codex": { model: "newer-model" }
      },
      locale: "zh-CN"
    })
  );

  const authoritative = await completion;
  assert.equal(
    authoritative.agentComposerDefaultsByAgentTarget?.["local:codex"]?.model,
    "newer-model"
  );
  client.dispose();
});

test("desktop preferences client fans out authoritative preference updates", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );
  const receivedUpdates: DesktopPreferencesStateResponse["preferences"][] = [];

  const unsubscribe = client.subscribeToDesktopPreferencesUpdated(
    (preferences) => {
      receivedUpdates.push(preferences);
    }
  );

  eventStreamClient.emitDesktopPreferencesUpdated(createStateResponse());

  assert.deepEqual(receivedUpdates, [createPreferences()]);

  unsubscribe();
  client.dispose();
});

test("desktop preferences client rejects pending writes when disposed", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    createFakeTuttidClient(),
    eventStreamClient
  );

  const completion = client.updateDesktopPreferences(createUpdateRequest());

  client.dispose();

  await assert.rejects(completion, /disposed/);
  assert.equal(eventStreamClient.disposeCalls, 0);
});

test("desktop preferences client confirms writes from HTTP when the event does not arrive", async () => {
  const tuttidClient = createFakeTuttidClient(createStateResponse());
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    tuttidClient,
    eventStreamClient,
    {
      authoritativeEventTimeoutMs: 0
    }
  );

  const completion = client.updateDesktopPreferences(createUpdateRequest());

  assert.deepEqual(await completion, createPreferences());
  assert.equal(tuttidClient.getDesktopPreferencesCalls, 1);

  client.dispose();
});

test("desktop preferences client notifies subscribers when HTTP confirmation succeeds without an event", async () => {
  const tuttidClient = createFakeTuttidClient(createStateResponse());
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    tuttidClient,
    eventStreamClient,
    {
      authoritativeEventTimeoutMs: 0
    }
  );
  const receivedUpdates: DesktopPreferencesStateResponse["preferences"][] = [];

  client.subscribeToDesktopPreferencesUpdated((preferences) => {
    receivedUpdates.push(preferences);
  });

  await client.updateDesktopPreferences(createUpdateRequest());

  assert.deepEqual(receivedUpdates, [createPreferences()]);

  client.dispose();
});

test("desktop preferences client rejects writes when the authoritative state cannot be confirmed", async () => {
  const tuttidClient = createFakeTuttidClient(
    createStateResponse({
      locale: "en",
      themeSource: "system"
    })
  );
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    tuttidClient,
    eventStreamClient,
    {
      authoritativeEventTimeoutMs: 0
    }
  );

  const completion = client.updateDesktopPreferences(createUpdateRequest());

  await assert.rejects(completion, /authoritative update did not arrive/);
  assert.equal(tuttidClient.getDesktopPreferencesCalls, 1);

  client.dispose();
});

test("desktop preferences client coalesces concurrent identical writes", async () => {
  const tuttidClient = createFakeTuttidClient();
  const eventStreamClient = createFakeEventStreamClient();
  const client = createDesktopPreferencesClient(
    tuttidClient,
    eventStreamClient,
    {
      authoritativeEventTimeoutMs: 5_000
    }
  );

  const firstCompletion = client.updateDesktopPreferences(
    createUpdateRequest()
  );
  const secondCompletion = client.updateDesktopPreferences(
    createUpdateRequest()
  );

  assert.equal(eventStreamClient.publishedIntents.length, 1);

  eventStreamClient.emitDesktopPreferencesUpdated(createStateResponse());

  const [firstResult, secondResult] = await Promise.all([
    firstCompletion,
    secondCompletion
  ]);
  assert.deepEqual(firstResult, secondResult);

  client.dispose();
});

function createPreferences(
  overrides: Partial<PutDesktopPreferencesRequest["preferences"]> = {}
): PutDesktopPreferencesRequest["preferences"] {
  return {
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    deletedAgentConversationRetentionDays: 30,
    dockIconStyle: "default",
    dockPlacement: "bottom",
    featureFlags: {},
    fileDefaultOpenersByExtension: { html: "defaultBrowser" },
    locale: "zh-CN",
    minimizeAnimation: "scale",
    sleepPreventionMode: "never",
    showAppDeveloperSources: false,
    themeSource: "dark",
    updateChannel: "stable",
    updatePolicy: "prompt",
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
    ...overrides
  };
}

function createStateResponse(
  overrides: Partial<PutDesktopPreferencesRequest["preferences"]> = {}
): DesktopPreferencesStateResponse {
  return {
    initialized: true,
    preferences: createPreferences(overrides)
  };
}

function createUpdateRequest(
  overrides: Partial<PutDesktopPreferencesRequest["preferences"]> = {}
): PutDesktopPreferencesRequest {
  return {
    preferences: createPreferences(overrides)
  };
}

function createFakeTuttidClient(
  response: DesktopPreferencesStateResponse = createStateResponse({
    locale: "en",
    themeSource: "system"
  })
): Pick<TuttidClient, "getDesktopPreferences"> & {
  getDesktopPreferencesCalls: number;
} {
  let getDesktopPreferencesCalls = 0;

  return {
    get getDesktopPreferencesCalls() {
      return getDesktopPreferencesCalls;
    },
    getDesktopPreferences: async () => {
      getDesktopPreferencesCalls += 1;
      return response;
    }
  };
}

function createFakeEventStreamClient(): TuttidEventStreamClient & {
  disposeCalls: number;
  emitDesktopPreferencesUpdated(
    payload: Extract<DesktopPreferencesStateResponse, { initialized: boolean }>
  ): void;
  publishedIntents: Array<{ payload: unknown; topic: string }>;
} {
  const listeners = new Set<
    (event: {
      emittedAt: string;
      id: string;
      payload: Extract<
        DesktopPreferencesStateResponse,
        { initialized: boolean }
      >;
      topic: "preferences.desktop.updated";
      version: 1;
    }) => void
  >();
  const publishedIntents: Array<{ payload: unknown; topic: string }> = [];
  let disposeCalls = 0;

  return {
    connect: async () => {},
    dispose() {
      disposeCalls += 1;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    emitDesktopPreferencesUpdated(payload) {
      for (const listener of listeners) {
        listener({
          emittedAt: "2026-05-30T08:00:00Z",
          id: "evt-1",
          payload,
          topic: "preferences.desktop.updated",
          version: 1
        });
      }
    },
    async publishIntent(topic, payload) {
      publishedIntents.push({
        payload,
        topic
      });
    },
    publishedIntents,
    subscribe(topic, listener) {
      assert.equal(topic, "preferences.desktop.updated");
      listeners.add(listener as Parameters<typeof listeners.add>[0]);
      return () => {
        listeners.delete(listener as Parameters<typeof listeners.add>[0]);
      };
    },
    subscribeConnectionState() {
      return () => {};
    }
  };
}
