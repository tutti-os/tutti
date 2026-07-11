import assert from "node:assert/strict";
import test from "node:test";
import {
  createTuttiExternalOperationError,
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
  await activeBridge.files.open({
    location: {
      path: " docs/readme.md ",
      type: "app-package-relative"
    },
    packageVersion: " v1.2.3 ",
    path: " /workspace/readme.md "
  });
  assert.deepEqual(harness.requests.at(-1), {
    input: {
      location: {
        path: "docs/readme.md",
        type: "app-package-relative"
      },
      packageVersion: "v1.2.3",
      path: "/workspace/readme.md"
    },
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

test("maps browser and upload validation failures to invalid_input", async () => {
  const harness = createAdapterHarness();
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });

  await assert.rejects(
    bridge.browser.openUrl({ url: "javascript:alert(1)" }),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "invalid_input" &&
      error.operation === "browser.openUrl"
  );
  await assert.rejects(
    bridge.files.upload({
      arrayBuffer() {},
      size: 0,
      slice() {},
      stream() {},
      text() {},
      type: "text/plain"
    } as unknown as Blob),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "invalid_input" &&
      error.operation === "files.upload"
  );
  await assert.rejects(
    bridge.files.upload(new Blob(), { purpose: "other" } as never),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "invalid_input" &&
      error.operation === "files.upload"
  );
  await assert.rejects(
    bridge.files.open({
      location: { path: "README.md", type: "app-package-relative" },
      path: "README.md"
    } as never),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "invalid_input" &&
      error.operation === "files.open"
  );
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.uploads, 0);
  assert.deepEqual(harness.requests, []);
});

test("preserves AbortError and maps exact host error codes", async () => {
  const harness = createAdapterHarness();
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });
  const abortError = Object.assign(new Error("aborted"), {
    name: "AbortError"
  });
  harness.uploadError = abortError;
  await assert.rejects(bridge.files.upload(new Blob()), (error: unknown) => {
    assert.equal(error, abortError);
    return true;
  });

  harness.setRequestError(
    "at.query",
    Object.assign(new Error("offline"), { code: "COMMON.UNAVAILABLE" })
  );
  await assert.rejects(
    bridge.at.query({ keyword: "test" }),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "unavailable" &&
      error.hostCode === "COMMON.UNAVAILABLE"
  );
  harness.setRequestError(
    "at.query",
    Object.assign(new Error("not invalid"), { code: "not_invalid_input" })
  );
  await assert.rejects(
    bridge.at.query({ keyword: "test" }),
    (error: unknown) =>
      isTuttiExternalOperationError(error) && error.code === "operation_failed"
  );
});

test("rebinds structured host errors to the active operation", async () => {
  const harness = createAdapterHarness();
  harness.setRequestError(
    "at.query",
    createTuttiExternalOperationError({
      code: "unavailable",
      message: "files unavailable",
      operation: "files.open"
    })
  );
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });
  await assert.rejects(
    bridge.at.query({ keyword: "test" }),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "unavailable" &&
      error.operation === "at.query"
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

test("maps subscription setup errors and reopens after failure", () => {
  const harness = createAdapterHarness();
  harness.failNextOpen(
    "app.contextChanged",
    Object.assign(new Error("offline"), { code: "common.unavailable" })
  );
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });
  assert.throws(
    () => bridge.app.subscribe(() => undefined),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "unavailable" &&
      error.hostCode === "common.unavailable" &&
      error.operation === "app.subscribe"
  );
  const unsubscribe = bridge.app.subscribe(() => undefined);
  assert.equal(harness.openAttempts.get("app.contextChanged"), 2);
  unsubscribe();
  assert.equal(harness.hostUnsubscribes, 1);
});

test("closes malformed adapter streams and allows reopen", () => {
  const harness = createAdapterHarness();
  harness.malformNextInitial("app.contextChanged");
  const bridge = createTuttiExternalBridge({
    adapter: harness.adapter,
    isUserActivationActive: () => true
  });
  assert.throws(
    () => bridge.app.subscribe(() => undefined),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "operation_failed" &&
      error.operation === "app.subscribe"
  );
  assert.equal(harness.hostUnsubscribes, 1);
  const unsubscribe = bridge.app.subscribe(() => undefined);
  assert.equal(harness.openAttempts.get("app.contextChanged"), 2);
  unsubscribe();
  assert.equal(harness.hostUnsubscribes, 2);

  harness.malformNextUnsubscribe("app.contextChanged");
  assert.throws(
    () => bridge.app.subscribe(() => undefined),
    (error: unknown) =>
      isTuttiExternalOperationError(error) &&
      error.code === "operation_failed" &&
      error.operation === "app.subscribe"
  );
  assert.equal(harness.openAttempts.get("app.contextChanged"), 3);
  assert.equal(harness.hostUnsubscribes, 2);
  const unsubscribeAfterMalformed = bridge.app.subscribe(() => undefined);
  unsubscribeAfterMalformed();
  assert.equal(harness.hostUnsubscribes, 3);
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
  const notifications: Array<{ input: unknown; operation: string }> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const initials = new Map<string, Promise<unknown>>();
  const openAttempts = new Map<string, number>();
  const openFailures = new Map<string, unknown[]>();
  const malformedInitialEvents = new Set<string>();
  const malformedUnsubscribeEvents = new Set<string>();
  const requestErrors = new Map<string, unknown>();
  const results = new Map<string, unknown>([
    ["files.open", undefined],
    ["app.getContext", { appId: "test" }]
  ]);
  const harness = {
    failNotifications: false,
    uploadError: undefined as unknown,
    uploads: 0,
    hostUnsubscribes: 0,
    notifications,
    openAttempts,
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
    },
    setRequestError(operation: string, error: unknown) {
      requestErrors.set(operation, error);
    },
    failNextOpen(event: string, error: unknown) {
      const failures = openFailures.get(event) ?? [];
      failures.push(error);
      openFailures.set(event, failures);
    },
    malformNextInitial(event: string) {
      malformedInitialEvents.add(event);
    },
    malformNextUnsubscribe(event: string) {
      malformedUnsubscribeEvents.add(event);
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
      if (requestErrors.has(operation)) {
        throw requestErrors.get(operation);
      }
      return results.get(
        operation
      ) as TuttiExternalRequestResultMap[TOperation];
    },
    notify<TOperation extends TuttiExternalNotifyOperation>(
      operation: TOperation,
      input: TuttiExternalNotificationInputMap[TOperation]
    ): void {
      notifications.push({ input, operation });
      if (harness.failNotifications) {
        throw new Error("notification failed");
      }
    },
    openEventStream<TEvent extends TuttiExternalHostEvent>(
      event: TEvent,
      listener: (payload: TuttiExternalHostEventPayloadMap[TEvent]) => void
    ) {
      openAttempts.set(event, (openAttempts.get(event) ?? 0) + 1);
      const failure = openFailures.get(event)?.shift();
      if (failure) {
        throw failure;
      }
      listeners.set(event, listener as (payload: unknown) => void);
      if (malformedUnsubscribeEvents.delete(event)) {
        return {
          initial: Promise.resolve(undefined),
          unsubscribe: null
        } as never;
      }
      if (malformedInitialEvents.delete(event)) {
        const malformedStream = {
          initial: undefined,
          unsubscribe() {
            assert.equal(this, malformedStream);
            harness.hostUnsubscribes += 1;
            listeners.delete(event);
          }
        };
        return malformedStream as never;
      }
      const stream = {
        initial: (initials.get(event) ?? Promise.resolve(undefined)) as Promise<
          TuttiExternalHostEventPayloadMap[TEvent] | undefined
        >,
        unsubscribe() {
          assert.equal(this, stream);
          harness.hostUnsubscribes += 1;
          listeners.delete(event);
        }
      };
      return stream;
    },
    async upload() {
      harness.uploads += 1;
      if (harness.uploadError) {
        throw harness.uploadError;
      }
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
