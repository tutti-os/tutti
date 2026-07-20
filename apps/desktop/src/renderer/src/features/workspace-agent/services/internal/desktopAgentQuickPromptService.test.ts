import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHostQuickPrompt } from "@tutti-os/agent-gui";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import { proxy } from "valtio";
import { AGENT_QUICK_PROMPT_LIBRARY_FLAG } from "../../../../../../shared/featureFlags/catalog.ts";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import { DesktopAgentQuickPromptService } from "./desktopAgentQuickPromptService.ts";

const firstPrompt: AgentHostQuickPrompt = {
  content: "Review the current changes",
  createdAtUnixMs: 10,
  id: "prompt-1",
  title: "Review",
  updatedAtUnixMs: 20,
  version: 1
};

test("quick prompts default disabled and enable without eager loading", async () => {
  const harness = createHarness();

  assert.equal(harness.service.getSnapshot().enabled, false);
  await assert.rejects(
    harness.service.ensureLoaded(),
    /quick_prompts\.disabled/
  );
  assert.equal(harness.calls.list, 0);

  harness.enable();
  await waitFor(() => harness.service.getSnapshot().enabled);
  assert.equal(harness.service.getSnapshot().status, "idle");
  assert.equal(harness.calls.list, 0);

  await harness.service.ensureLoaded();
  assert.equal(harness.calls.list, 1);
  assert.deepEqual(harness.service.getSnapshot().prompts, [firstPrompt]);
  assert.equal(harness.service.getSnapshot().status, "ready");
  harness.service.dispose();
});

test("quick prompts CRUD publishes immutable committed snapshots", async () => {
  const harness = createHarness({ enabled: true });
  await harness.service.ensureLoaded();

  const created = await harness.service.create({
    content: "Create tests",
    title: "Tests"
  });
  assert.equal(harness.calls.create, 1);
  assert.equal(created.id, "prompt-2");
  assert.deepEqual(
    harness.service.getSnapshot().prompts.map((prompt) => prompt.id),
    ["prompt-2", "prompt-1"]
  );

  const updated = await harness.service.update({
    content: "Create focused tests",
    expectedVersion: created.version,
    id: created.id,
    title: "Focused tests"
  });
  assert.equal(harness.calls.update, 1);
  assert.equal(updated.version, 2);
  assert.equal(
    harness.service.getSnapshot().prompts[0]?.title,
    "Focused tests"
  );

  await harness.service.remove({
    expectedVersion: updated.version,
    id: updated.id
  });
  assert.equal(harness.calls.remove, 1);
  assert.deepEqual(
    harness.service.getSnapshot().prompts.map((prompt) => prompt.id),
    ["prompt-1"]
  );
  assert.deepEqual(harness.service.getSnapshot().pendingMutationIds, []);
  assert.equal(Object.isFrozen(harness.service.getSnapshot()), true);
  assert.equal(Object.isFrozen(harness.service.getSnapshot().prompts), true);
  harness.service.dispose();
});

test("quick prompt global events coalesce refresh and skip an applied mutation", async () => {
  const harness = createHarness({ enabled: true });
  await harness.service.ensureLoaded();

  harness.emit({
    changeKind: "updated",
    promptId: "remote-prompt",
    version: 2
  });
  harness.emit({
    changeKind: "deleted",
    promptId: "another-prompt",
    version: 1
  });
  await waitFor(() => harness.calls.list === 2);
  assert.equal(harness.calls.list, 2);

  const updated = await harness.service.update({
    content: "Review carefully",
    expectedVersion: 1,
    id: firstPrompt.id,
    title: firstPrompt.title
  });
  harness.emit({
    changeKind: "updated",
    promptId: updated.id,
    version: updated.version
  });
  await Promise.resolve();
  assert.equal(harness.calls.list, 2);
  harness.service.dispose();
});

test("quick prompt events received during a list request trigger a fresh follow-up list", async () => {
  const secondList = deferred<{ prompts: AgentHostQuickPrompt[] }>();
  const remotePrompt = {
    ...firstPrompt,
    id: "remote-prompt",
    title: "Remote",
    updatedAtUnixMs: 50
  };
  const harness = createHarness({
    enabled: true,
    list: (call) => {
      if (call === 2) return secondList.promise;
      return Promise.resolve({
        prompts: call === 3 ? [remotePrompt, firstPrompt] : [firstPrompt]
      });
    }
  });
  await harness.service.ensureLoaded();

  const refresh = harness.service.ensureLoaded({ force: true });
  await waitFor(() => harness.calls.list === 2);
  harness.emit({
    changeKind: "created",
    promptId: remotePrompt.id,
    version: remotePrompt.version
  });
  await Promise.resolve();
  secondList.resolve({ prompts: [firstPrompt] });
  await refresh;

  assert.equal(harness.calls.list, 3);
  assert.deepEqual(
    harness.service.getSnapshot().prompts.map((prompt) => prompt.id),
    [remotePrompt.id, firstPrompt.id]
  );
  harness.service.dispose();
});

test("re-enabling quick prompts keeps loading lazy and invalidates the old list", async () => {
  let remotePrompts: AgentHostQuickPrompt[] = [firstPrompt];
  const harness = createHarness({
    enabled: true,
    list: async () => ({ prompts: remotePrompts })
  });
  await harness.service.ensureLoaded();

  harness.disable();
  await waitFor(() => !harness.service.getSnapshot().enabled);
  remotePrompts = [
    {
      ...firstPrompt,
      id: "created-while-disabled",
      title: "Created elsewhere",
      updatedAtUnixMs: 60
    }
  ];
  harness.emit({
    changeKind: "created",
    promptId: remotePrompts[0]!.id,
    version: remotePrompts[0]!.version
  });
  harness.enable();
  await waitFor(() => harness.service.getSnapshot().enabled);

  assert.equal(harness.service.getSnapshot().status, "idle");
  assert.equal(harness.calls.list, 1);
  await harness.service.ensureLoaded();
  assert.equal(harness.calls.list, 2);
  assert.deepEqual(harness.service.getSnapshot().prompts, remotePrompts);
  harness.service.dispose();
});

test("reopening after a fast disable and enable reruns an in-flight stale list", async () => {
  const staleList = deferred<{ prompts: AgentHostQuickPrompt[] }>();
  const remotePrompt = {
    ...firstPrompt,
    id: "fresh-after-reenable",
    title: "Fresh",
    updatedAtUnixMs: 70
  };
  const harness = createHarness({
    enabled: true,
    list: (call) =>
      call === 1
        ? staleList.promise
        : Promise.resolve({ prompts: [remotePrompt] })
  });
  const originalLoad = harness.service.ensureLoaded();
  await waitFor(() => harness.calls.list === 1);

  harness.disable();
  await waitFor(() => !harness.service.getSnapshot().enabled);
  harness.enable();
  await waitFor(() => harness.service.getSnapshot().enabled);
  const reopenedLoad = harness.service.ensureLoaded();
  staleList.resolve({ prompts: [firstPrompt] });
  await Promise.all([originalLoad, reopenedLoad]);

  assert.equal(harness.calls.list, 2);
  assert.equal(harness.service.getSnapshot().status, "ready");
  assert.deepEqual(harness.service.getSnapshot().prompts, [remotePrompt]);
  harness.service.dispose();
});

test("disabling quick prompts is immediate, fail closed, and dispose releases subscriptions", async () => {
  const harness = createHarness({ enabled: true });
  let notifications = 0;
  harness.service.subscribe(() => notifications++);
  await harness.service.ensureLoaded();

  harness.disable();
  await waitFor(() => !harness.service.getSnapshot().enabled);
  const callsBeforeDisabledOperations = { ...harness.calls };
  await assert.rejects(
    harness.service.create({ content: "No", title: "Disabled" }),
    /quick_prompts\.disabled/
  );
  await assert.rejects(
    harness.service.update({
      content: "No",
      expectedVersion: 1,
      id: firstPrompt.id,
      title: "Disabled"
    }),
    /quick_prompts\.disabled/
  );
  await assert.rejects(
    harness.service.remove({ expectedVersion: 1, id: firstPrompt.id }),
    /quick_prompts\.disabled/
  );
  assert.deepEqual(harness.calls, callsBeforeDisabledOperations);

  const notificationsBeforeDispose = notifications;
  harness.service.dispose();
  harness.enable();
  harness.emit({
    changeKind: "updated",
    promptId: firstPrompt.id,
    version: 3
  });
  await Promise.resolve();
  assert.equal(notifications, notificationsBeforeDispose);
  assert.equal(harness.calls.list, callsBeforeDisabledOperations.list);
});

function createHarness(
  input: {
    enabled?: boolean;
    list?: (call: number) => Promise<{ prompts: AgentHostQuickPrompt[] }>;
  } = {}
) {
  const calls = { create: 0, list: 0, remove: 0, update: 0 };
  const preferencesStore = proxy({
    changingFeatureFlags: null as Record<string, boolean> | null,
    featureFlags: input.enabled
      ? { [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: true }
      : {}
  });
  let eventListener:
    | ((event: {
        payload: {
          promptId: string;
          changeKind: "created" | "updated" | "deleted";
          version: number;
          occurredAtUnixMs: number;
        };
      }) => void)
    | null = null;
  const eventStreamClient = {
    async connect() {},
    dispose() {},
    async publishIntent() {},
    subscribe(_topic: string, listener: typeof eventListener) {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    },
    subscribeConnectionState() {
      return () => {};
    }
  } as unknown as TuttidEventStreamClient;
  const tuttidClient = {
    async listAgentQuickPrompts() {
      calls.list++;
      if (input.list) return input.list(calls.list);
      return { prompts: [firstPrompt] };
    },
    async createAgentQuickPrompt(input: { title: string; content: string }) {
      calls.create++;
      return {
        ...firstPrompt,
        ...input,
        id: "prompt-2",
        updatedAtUnixMs: 30
      };
    },
    async updateAgentQuickPrompt(
      id: string,
      input: {
        title: string;
        content: string;
        expectedVersion: number;
      }
    ) {
      calls.update++;
      return {
        ...firstPrompt,
        ...input,
        id,
        updatedAtUnixMs: 40,
        version: input.expectedVersion + 1
      };
    },
    async deleteAgentQuickPrompt() {
      calls.remove++;
    }
  } as unknown as TuttidClient;
  const desktopPreferencesService = {
    _serviceBrand: undefined,
    store: preferencesStore
  } as unknown as IDesktopPreferencesService;
  const service = new DesktopAgentQuickPromptService({
    desktopPreferencesService,
    eventStreamClient,
    tuttidClient
  });
  return {
    calls,
    disable() {
      preferencesStore.featureFlags = {
        [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: false
      };
    },
    emit(payload: {
      promptId: string;
      changeKind: "created" | "updated" | "deleted";
      version: number;
    }) {
      eventListener?.({ payload: { ...payload, occurredAtUnixMs: 100 } });
    },
    enable() {
      preferencesStore.featureFlags = {
        [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: true
      };
    },
    service
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition did not become true");
}
