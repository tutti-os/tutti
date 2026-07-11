import assert from "node:assert/strict";
import test from "node:test";
import {
  isTuttiExternalOperationError,
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalWorkspaceAgentProviders,
  tuttiExternalWorkspaceFeatures
} from "../core/index.ts";
import { createTuttiExternalBridge } from "./bridge.ts";
import { tuttiExternalOperations } from "./operation-map.ts";
import type {
  TuttiExternalHostAdapter,
  TuttiExternalHostEvent,
  TuttiExternalHostEventPayloadMap,
  TuttiExternalNotificationInputMap,
  TuttiExternalNotifyOperation,
  TuttiExternalRequestInputMap,
  TuttiExternalRequestOperation,
  TuttiExternalRequestResultMap
} from "./types.ts";

test("keeps one canonical roster of 26 operations", () => {
  assert.equal(tuttiExternalOperations.length, 26);
  assert.equal(new Set(tuttiExternalOperations).size, 26);
});

test("normalizes requests and rejects activation failures asynchronously", async () => {
  const harness = createAdapterHarness();
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => false
  });

  const pending = bridge.files.open({ path: " /workspace/readme.md " });
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(isTuttiExternalOperationError(error), true);
    if (isTuttiExternalOperationError(error)) {
      assert.equal(error.code, "user_activation_required");
      assert.equal(error.operation, "files.open");
    }
    return true;
  });
  assert.deepEqual(harness.requests, []);

  const activeBridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });
  await activeBridge.files.open({ path: " /workspace/readme.md " });
  assert.deepEqual(harness.requests.at(-1), {
    input: { path: "/workspace/readme.md" },
    operation: "files.open"
  });
});

test("maps invalid input to a structured rejected Promise", async () => {
  const harness = createAdapterHarness();
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });

  await assert.rejects(
    bridge.at.query({ keyword: "", maxResults: Number.NaN }),
    (error: unknown) => {
      assert.equal(isTuttiExternalOperationError(error), true);
      if (isTuttiExternalOperationError(error)) {
        assert.equal(error.code, "invalid_input");
        assert.equal(error.operation, "at.query");
      }
      return true;
    }
  );
});

test("rejects unsupported managed model providers for settings", async () => {
  const harness = createAdapterHarness({ managedAiProviders: ["openai"] });
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });

  await assert.rejects(
    bridge.settings.open({ tab: "models", provider: "anthropic" }),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "unsupported_operation" &&
      error.operation === "settings.open"
  );
});

test("rejects invalid user project selection results", async () => {
  const harness = createAdapterHarness();
  harness.setResult("userProjects.prepareSelection", {
    isSelectedPathMissing: false,
    projects: [],
    selection: { kind: "unexpected" }
  });
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });

  await assert.rejects(
    bridge.userProjects.prepareSelection({
      projectLocked: false,
      selectedPath: null
    }),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "operation_failed" &&
      error.operation === "userProjects.prepareSelection"
  );
});

test("throws structured unsupported errors for synchronous subscriptions", () => {
  const harness = createAdapterHarness({ operations: ["app.getContext"] });
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });

  assert.throws(
    () => bridge.workspace.onLaunchIntent(() => undefined),
    (error: unknown) => {
      assert.equal(isTuttiExternalOperationError(error), true);
      if (isTuttiExternalOperationError(error)) {
        assert.equal(error.code, "unsupported_operation");
        assert.equal(error.operation, "workspace.onLaunchIntent");
      }
      return true;
    }
  );
});

test("delivers initial event before buffered future events and isolates listeners", async () => {
  const harness = createAdapterHarness();
  let resolveInitial: ((value: unknown) => void) | undefined;
  harness.setInitial(
    "app.contextChanged",
    new Promise((resolve) => {
      resolveInitial = resolve;
    })
  );
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });
  const received: unknown[] = [];
  bridge.app.subscribe(() => {
    throw new Error("listener failure");
  });
  const unsubscribe = bridge.app.subscribe((context) => received.push(context));

  harness.emit("app.contextChanged", { version: 2 });
  assert.deepEqual(received, []);
  resolveInitial?.({ version: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ version: 1 }, { version: 2 }]);

  unsubscribe();
  unsubscribe();
  harness.emit("app.contextChanged", { version: 3 });
  assert.deepEqual(received, [{ version: 1 }, { version: 2 }]);
});

test("freezes public capabilities and keeps log failures silent", () => {
  const harness = createAdapterHarness();
  harness.failNotifications = true;
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });

  assert.equal(Object.isFrozen(bridge.capabilities), true);
  assert.equal(Object.isFrozen(bridge.capabilities?.operations), true);
  assert.doesNotThrow(() => bridge.logs.write({ event: "test" }));
});

function createAdapterHarness(options?: {
  managedAiProviders?: TuttiExternalHostAdapter["capabilities"]["managedAiProviders"];
  operations?: TuttiExternalHostAdapter["capabilities"]["operations"];
}) {
  const requests: Array<{ input: unknown; operation: string }> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const initials = new Map<string, Promise<unknown>>();
  const results = new Map<string, unknown>([
    ["files.open", undefined],
    ["app.getContext", { appId: "test" }]
  ]);
  const harness = {
    failNotifications: false,
    requests,
    adapter: undefined as unknown as TuttiExternalHostAdapter,
    emit<TEvent extends TuttiExternalHostEvent>(
      event: TEvent,
      payload: TuttiExternalHostEventPayloadMap[TEvent]
    ) {
      listeners.get(event)?.(payload);
    },
    setInitial<TEvent extends TuttiExternalHostEvent>(
      event: TEvent,
      initial: Promise<TuttiExternalHostEventPayloadMap[TEvent] | undefined>
    ) {
      initials.set(event, initial);
    },
    setResult(operation: string, result: unknown) {
      results.set(operation, result);
    }
  };

  harness.adapter = {
    capabilities: {
      operations: options?.operations ?? tuttiExternalOperations,
      atProviders: tuttiExternalAtProviderIds,
      managedAiProviders:
        options?.managedAiProviders ?? tuttiExternalManagedAiModelProviderIds,
      workspaceAgentProviders: tuttiExternalWorkspaceAgentProviders,
      workspaceFeatures: tuttiExternalWorkspaceFeatures
    },
    async request<TOperation extends TuttiExternalRequestOperation>(
      operation: TOperation,
      input: TuttiExternalRequestInputMap[TOperation]
    ): Promise<TuttiExternalRequestResultMap[TOperation]> {
      requests.push({ input, operation });
      return results.get(
        operation
      ) as TuttiExternalRequestResultMap[TOperation];
    },
    notify<TOperation extends TuttiExternalNotifyOperation>(
      _operation: TOperation,
      _input: TuttiExternalNotificationInputMap[TOperation]
    ): void {
      if (harness.failNotifications) {
        throw new Error("notification failed");
      }
    },
    openEventStream<TEvent extends TuttiExternalHostEvent>(
      event: TEvent,
      listener: (payload: TuttiExternalHostEventPayloadMap[TEvent]) => void
    ) {
      listeners.set(event, listener as (payload: unknown) => void);
      return {
        initial: (initials.get(event) ?? Promise.resolve(undefined)) as Promise<
          TuttiExternalHostEventPayloadMap[TEvent] | undefined
        >,
        unsubscribe() {
          listeners.delete(event);
        }
      };
    },
    async upload() {
      return {
        mimeType: "application/octet-stream",
        name: "upload.bin",
        path: "/uploads/upload.bin",
        sha256: "sha256",
        sizeBytes: 0
      };
    }
  };
  return harness;
}
