import {
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalOperations,
  tuttiExternalWorkspaceAgentProviders,
  type TuttiExternalOperation
} from "../../contracts/index.ts";
import {
  createTuttiExternalOperationError,
  isTuttiExternalOperationError,
  tuttiExternalWorkspaceFeatures
} from "../../core/index.ts";
import { tuttiExternalUserActivationOperations } from "../operation-map.ts";
import type {
  TuttiExternalHostEventPayloadMap,
  TuttiExternalRequestOperation
} from "../types.ts";
import { assertConformance, assertConformanceEqual } from "./assertions.ts";
import {
  tuttiExternalStable26InvalidResultFixtures,
  tuttiExternalStable26OperationFixtures
} from "./fixtures.ts";
import { tuttiExternalStable26ConformanceProfile } from "./profile.ts";
import type {
  TuttiExternalConformanceCase,
  TuttiExternalConformanceHost,
  TuttiExternalConformanceObservations,
  TuttiExternalConformanceOperationFixture
} from "./types.ts";

const profileCase: TuttiExternalConformanceCase = {
  id: "stable26-profile",
  title: "exposes the fixed stable26 operation and value-domain profile",
  async run({ bridge }) {
    const capabilities = bridge.capabilities;
    assertConformance(capabilities, "stable26 capabilities are required");
    assertConformanceEqual(
      capabilities,
      tuttiExternalStable26ConformanceProfile.capabilities,
      "capabilities must exactly match the stable26 profile"
    );
    assertConformance(
      Object.isFrozen(capabilities),
      "capabilities must be frozen"
    );
    for (const value of Object.values(capabilities)) {
      assertConformance(
        Object.isFrozen(value),
        "capability rosters must be frozen"
      );
    }
    assertConformanceEqual(
      tuttiExternalUserActivationOperations,
      tuttiExternalStable26ConformanceProfile.activationOperations,
      "the host activation policy must match the fixed ten-operation profile"
    );
  }
};

const operationCase: TuttiExternalConformanceCase = {
  id: "stable26-operations",
  title: "routes all 26 operations with canonical inputs and results",
  async run(host) {
    const { bridge, port } = host;
    port.setUserActivationActive(true);

    for (const operation of tuttiExternalOperations) {
      const fixture = tuttiExternalStable26OperationFixtures[operation];
      port.resetObservations();
      if (fixture.kind === "request") {
        setFixtureRequestResult(port, fixture);
        const result = await invokeDataFixture(bridge, fixture);
        assertConformanceEqual(
          result,
          fixture.result,
          `${operation} must preserve its canonical result`
        );
        assertConformanceEqual(
          port.getObservations().requests,
          [{ input: fixture.expectedInput, operation }],
          `${operation} must route one normalized request`
        );
      } else if (fixture.kind === "notification") {
        await invokeDataFixture(bridge, fixture);
        assertConformanceEqual(
          port.getObservations().notifications,
          [{ input: fixture.expectedInput, operation }],
          `${operation} must route one normalized notification`
        );
      } else if (fixture.kind === "upload") {
        port.setUploadResult(fixture.result);
        const result = await fixture.invoke(
          bridge,
          fixture.file,
          fixture.input
        );
        assertConformanceEqual(
          result,
          fixture.result,
          "files.upload must preserve its validated result"
        );
        const uploads = port.getObservations().uploads;
        assertConformanceEqual(
          uploads.length,
          1,
          "files.upload must route once"
        );
        assertConformanceEqual(
          omitUploadCallbacks(uploads[0]?.input),
          fixture.expectedInput,
          "files.upload must normalize its input"
        );
      } else {
        port.setInitial(fixture.event, undefined);
        const unsubscribe = fixture.invoke(bridge, () => undefined);
        await port.settle();
        assertConformanceEqual(
          port.getObservations().openedEvents,
          [fixture.event],
          `${operation} must open its canonical event stream`
        );
        unsubscribe();
        assertConformanceEqual(
          port.getObservations().unsubscribedEvents,
          [fixture.event],
          `${operation} must close its canonical event stream`
        );
      }
    }
  }
};

const activationCase: TuttiExternalConformanceCase = {
  id: "activation-policy",
  title: "blocks every activation-gated operation before host transport",
  async run({ bridge, port }) {
    port.setUserActivationActive(false);
    for (const operation of tuttiExternalStable26ConformanceProfile.activationOperations) {
      port.resetObservations();
      const fixture = tuttiExternalStable26OperationFixtures[operation];
      await expectOperationError(
        invokeDataFixtureAsPromise(bridge, fixture),
        operation,
        "user_activation_required"
      );
      assertNoHostObservations(
        port.getObservations(),
        `${operation} activation failure`
      );
    }
  }
};

const invalidResultCase: TuttiExternalConformanceCase = {
  id: "invalid-results",
  title: "maps every invalid request and upload result to operation_failed",
  async run({ bridge, port }) {
    port.setUserActivationActive(true);

    const opaqueContext = Symbol("opaque-context");
    port.setRawRequestResult("app.getContext", opaqueContext);
    assertConformanceEqual(
      await bridge.app.getContext(),
      opaqueContext,
      "app.getContext must preserve its intentionally unknown result"
    );

    for (const operation of Object.keys(
      tuttiExternalStable26InvalidResultFixtures
    ) as Array<keyof typeof tuttiExternalStable26InvalidResultFixtures>) {
      port.resetObservations();
      const invalidResult =
        tuttiExternalStable26InvalidResultFixtures[operation];
      if (operation === "files.upload") {
        const fixture = tuttiExternalStable26OperationFixtures[operation];
        port.setRawUploadResult(invalidResult);
        await expectOperationError(
          fixture.invoke(bridge, fixture.file, fixture.input),
          operation,
          "operation_failed"
        );
      } else {
        const fixture = tuttiExternalStable26OperationFixtures[operation];
        port.setRawRequestResult(operation, invalidResult);
        await expectOperationError(
          invokeDataFixtureAsPromise(bridge, fixture),
          operation,
          "operation_failed"
        );
      }
    }
  }
};

const valueDomainCase: TuttiExternalConformanceCase = {
  id: "value-domain-routing",
  title: "routes every stable provider and feature value",
  async run({ bridge, port }) {
    port.setUserActivationActive(true);

    for (const provider of tuttiExternalAtProviderIds) {
      port.resetObservations();
      port.setRequestResult("at.query", []);
      await bridge.at.query({ keyword: "fixture", providers: [provider] });
      assertSingleRequest(port, "at.query", {
        keyword: "fixture",
        maxResults: 20,
        providers: [provider]
      });
    }

    for (const feature of tuttiExternalWorkspaceFeatures) {
      port.resetObservations();
      port.setRequestResult("workspace.openFeature", undefined);
      await bridge.workspace.openFeature({ feature });
      assertSingleRequest(port, "workspace.openFeature", { feature });
    }

    for (const provider of tuttiExternalWorkspaceAgentProviders) {
      port.resetObservations();
      port.setRequestResult("workspace.openFeature", undefined);
      await bridge.workspace.openFeature({
        draftPrompt: " Review this ",
        feature: "agent-chat",
        provider
      });
      assertSingleRequest(port, "workspace.openFeature", {
        draftPrompt: "Review this",
        feature: "agent-chat",
        provider
      });
    }

    for (const provider of tuttiExternalManagedAiModelProviderIds) {
      port.resetObservations();
      port.setRequestResult("permissions.request", { code: "grant-code" });
      await bridge.permissions.request({
        nonce: " nonce ",
        permission: "managed-ai-models",
        providers: [provider],
        scopes: [" models:read "],
        state: " state "
      });
      assertSingleRequest(port, "permissions.request", {
        nonce: "nonce",
        permission: "managed-ai-models",
        providers: [provider],
        scopes: ["models:read"],
        state: "state"
      });
    }
  }
};

const hostErrorCase: TuttiExternalConformanceCase = {
  id: "host-errors",
  title: "rebinds structured errors and applies notification error policy",
  async run({ bridge, port }) {
    port.setUserActivationActive(true);
    port.setRequestError(
      "at.query",
      createTuttiExternalOperationError({
        code: "unauthorized",
        hostCode: "AUTH.DENIED",
        message: "wrong operation",
        operation: "files.open"
      })
    );
    await expectOperationError(
      bridge.at.query({ keyword: "fixture" }),
      "at.query",
      "unauthorized",
      "AUTH.DENIED"
    );
    port.clearRequestError("at.query");

    port.setNotificationError(
      "browser.openUrl",
      Object.assign(new Error("offline"), { code: "COMMON.UNAVAILABLE" })
    );
    await expectOperationError(
      bridge.browser.openUrl({ url: "https://example.com" }),
      "browser.openUrl",
      "unavailable",
      "COMMON.UNAVAILABLE"
    );
    port.clearNotificationError("browser.openUrl");

    port.resetObservations();
    port.setNotificationError("logs.write", new Error("diagnostic failure"));
    assertConformanceDoesNotThrow(
      () => bridge.logs.write({ event: "conformance.log" }),
      "logs.write host failures must stay silent"
    );
    assertConformanceEqual(
      port.getObservations().notifications,
      [
        {
          input: { event: "conformance.log" },
          operation: "logs.write"
        }
      ],
      "logs.write must still attempt one normalized notification"
    );
    port.clearNotificationError("logs.write");
  }
};

const eventCase: TuttiExternalConformanceCase = {
  id: "event-ordering-and-isolation",
  title: "orders, replays, isolates, and cleans up all three event streams",
  async run(host) {
    await assertReplayEvent(
      host,
      tuttiExternalStable26OperationFixtures["app.subscribe"]
    );
    await assertLaunchIntentEvent(
      host,
      tuttiExternalStable26OperationFixtures["workspace.onLaunchIntent"]
    );
    await assertReplayEvent(
      host,
      tuttiExternalStable26OperationFixtures["userProjects.subscribe"]
    );
  }
};

const uploadCase: TuttiExternalConformanceCase = {
  id: "upload-progress-and-abort",
  title: "normalizes upload progress and preserves AbortError",
  async run({ bridge, port }) {
    const fixture = tuttiExternalStable26OperationFixtures["files.upload"];
    const progress = [
      { loadedBytes: 3, ratio: 3 / 7, totalBytes: 7 },
      { loadedBytes: 7, ratio: 1, totalBytes: 7 }
    ] as const;
    const received: unknown[] = [];
    port.setUploadResult(fixture.result);
    port.setUploadProgress(progress);
    const result = await bridge.files.upload(fixture.file, {
      name: "fixture.txt",
      onProgress(value) {
        received.push(value);
        if (received.length === 1) {
          throw new Error("observer failure");
        }
      }
    });
    assertConformanceEqual(
      result,
      fixture.result,
      "upload must return metadata"
    );
    assertConformanceEqual(
      received,
      progress,
      "throwing progress listeners must not stop later progress"
    );

    port.resetObservations();
    const controller = new AbortController();
    controller.abort();
    await expectAbortError(
      bridge.files.upload(fixture.file, { signal: controller.signal })
    );
    assertConformanceEqual(
      port.getObservations().uploads,
      [],
      "pre-aborted uploads must not reach the host"
    );

    port.resetObservations();
    port.blockUploadTransferUntilAbort();
    const inFlightController = new AbortController();
    const inFlightUpload = bridge.files.upload(fixture.file, {
      onProgress() {},
      signal: inFlightController.signal
    });
    await port.waitForUploadTransfer();
    inFlightController.abort();
    await expectAbortError(inFlightUpload);
    assertConformanceEqual(
      port.getObservations().uploadPhases,
      ["prepare", "transfer", "transfer-abort", "cancel"],
      "in-flight abort must cancel exactly once without completing"
    );

    port.resetObservations();
    const hostAbort = new DOMException("host aborted", "AbortError");
    port.setUploadError(hostAbort);
    try {
      await expectAbortError(bridge.files.upload(fixture.file));
    } finally {
      port.clearUploadError();
    }
  }
};

export const tuttiExternalStable26ConformanceCases = Object.freeze([
  freezeConformanceCase(profileCase),
  freezeConformanceCase(operationCase),
  freezeConformanceCase(activationCase),
  freezeConformanceCase(invalidResultCase),
  freezeConformanceCase(valueDomainCase),
  freezeConformanceCase(hostErrorCase),
  freezeConformanceCase(eventCase),
  freezeConformanceCase(uploadCase)
]) satisfies readonly TuttiExternalConformanceCase[];

function freezeConformanceCase(
  conformanceCase: TuttiExternalConformanceCase
): TuttiExternalConformanceCase {
  Object.freeze(conformanceCase.run);
  return Object.freeze(conformanceCase);
}

async function assertReplayEvent<
  TEvent extends "app.contextChanged" | "userProjects.changed"
>(
  host: TuttiExternalConformanceHost,
  fixture: {
    readonly event: TEvent;
    readonly initial: TuttiExternalHostEventPayloadMap[TEvent];
    invoke(
      bridge: TuttiExternalConformanceHost["bridge"],
      listener: (payload: unknown) => void
    ): () => void;
    readonly live: TuttiExternalHostEventPayloadMap[TEvent];
    readonly operation: string;
  }
): Promise<void> {
  const { bridge, port } = host;
  port.resetObservations();
  let resolveInitial:
    | ((value: TuttiExternalHostEventPayloadMap[TEvent]) => void)
    | undefined;
  port.setInitial(
    fixture.event,
    new Promise((resolve) => {
      resolveInitial = resolve;
    })
  );
  const received: unknown[] = [];
  const unsubscribeFailing = fixture.invoke(bridge, () => {
    throw new Error("observer failure");
  });
  const unsubscribe = fixture.invoke(bridge, (value) => received.push(value));
  port.emit(fixture.event, fixture.live);
  assertConformanceEqual(
    received,
    [],
    `${fixture.operation} live events must wait for the initial event`
  );
  resolveInitial?.(fixture.initial);
  await port.settle();
  assertConformanceEqual(
    received,
    [fixture.initial, fixture.live],
    `${fixture.operation} initial event must precede buffered live events`
  );

  const replayed: unknown[] = [];
  const unsubscribeReplay = fixture.invoke(bridge, (value) =>
    replayed.push(value)
  );
  assertConformanceEqual(
    replayed,
    [fixture.live],
    `${fixture.operation} must replay the latest event to a new listener`
  );

  unsubscribeFailing();
  unsubscribe();
  unsubscribeReplay();
  unsubscribeReplay();
  port.emit(fixture.event, fixture.live);
  await port.settle();
  assertConformanceEqual(
    received,
    [fixture.initial, fixture.live],
    `${fixture.operation} must stop delivery after cleanup`
  );
  assertConformanceEqual(
    port.getObservations().unsubscribedEvents,
    [fixture.event],
    `${fixture.operation} must close its host stream exactly once`
  );
}

async function assertLaunchIntentEvent(
  host: TuttiExternalConformanceHost,
  fixture: (typeof tuttiExternalStable26OperationFixtures)["workspace.onLaunchIntent"]
): Promise<void> {
  const { bridge, port } = host;
  port.resetObservations();
  let resolveInitial: ((value: typeof fixture.initial) => void) | undefined;
  port.setInitial(
    fixture.event,
    new Promise((resolve) => {
      resolveInitial = resolve;
    })
  );
  const received: unknown[] = [];
  const unsubscribeFailing = fixture.invoke(bridge, () => {
    throw new Error("observer failure");
  });
  const unsubscribe = fixture.invoke(bridge, (value) => received.push(value));
  port.emit(fixture.event, fixture.live);
  port.emit(fixture.event, fixture.live);
  assertConformanceEqual(
    received,
    [],
    "launch intent live events must wait for the initial intent"
  );
  resolveInitial?.(fixture.initial);
  await port.settle();
  assertConformanceEqual(
    received,
    [fixture.initial, fixture.live, fixture.live],
    "equal launch intents must remain ordered events without deduplication"
  );
  unsubscribeFailing();
  unsubscribe();
  port.emit(fixture.event, fixture.live);
  await port.settle();
  assertConformanceEqual(
    received,
    [fixture.initial, fixture.live, fixture.live],
    "launch intent cleanup must stop delivery"
  );
  assertConformanceEqual(
    port.getObservations().unsubscribedEvents,
    [fixture.event],
    "launch intent cleanup must close its host stream exactly once"
  );
}

function setFixtureRequestResult<
  TOperation extends TuttiExternalRequestOperation
>(
  port: TuttiExternalConformanceHost["port"],
  fixture: TuttiExternalConformanceOperationFixture<TOperation>
): void {
  if (fixture.kind !== "request") {
    throw new Error("request fixture expected");
  }
  port.setRequestResult(fixture.operation, fixture.result);
}

function invokeDataFixture(
  bridge: TuttiExternalConformanceHost["bridge"],
  fixture:
    | Extract<
        (typeof tuttiExternalStable26OperationFixtures)[keyof typeof tuttiExternalStable26OperationFixtures],
        { kind: "notification" }
      >
    | Extract<
        (typeof tuttiExternalStable26OperationFixtures)[keyof typeof tuttiExternalStable26OperationFixtures],
        { kind: "request" }
      >
): Promise<unknown> | void {
  // The mapped fixture type preserves each operation/input pair, but a runtime
  // loop necessarily sees their union. Construction is the typed boundary.
  const invoke = fixture.invoke as (
    bridge: TuttiExternalConformanceHost["bridge"],
    input: unknown
  ) => Promise<unknown> | void;
  return invoke(bridge, fixture.input);
}

async function invokeDataFixtureAsPromise(
  bridge: TuttiExternalConformanceHost["bridge"],
  fixture: Parameters<typeof invokeDataFixture>[1]
): Promise<unknown> {
  return await invokeDataFixture(bridge, fixture);
}

function assertNoHostObservations(
  observations: TuttiExternalConformanceObservations,
  label: string
): void {
  assertConformanceEqual(
    observations,
    {
      notifications: [],
      openedEvents: [],
      requests: [],
      unsubscribedEvents: [],
      uploadPhases: [],
      uploads: []
    },
    `${label} must make zero host calls`
  );
}

function assertSingleRequest<TOperation extends TuttiExternalRequestOperation>(
  port: TuttiExternalConformanceHost["port"],
  operation: TOperation,
  input: unknown
): void {
  assertConformanceEqual(
    port.getObservations().requests,
    [{ input, operation }],
    `${operation} must route one normalized request`
  );
}

function assertConformanceDoesNotThrow(
  action: () => void,
  message: string
): void {
  try {
    action();
  } catch (error) {
    throw new Error(`tuttiExternal conformance: ${message}.`, {
      cause: error
    });
  }
}

function omitUploadCallbacks(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const {
    onProgress: _onProgress,
    signal: _signal,
    ...input
  } = value as Record<string, unknown>;
  return input;
}

async function expectOperationError(
  pending: Promise<unknown>,
  operation: TuttiExternalOperation,
  code: string,
  hostCode?: string
): Promise<void> {
  try {
    await pending;
  } catch (error) {
    assertConformance(
      isTuttiExternalOperationError(error),
      `${operation} must reject with a structured operation error`
    );
    assertConformanceEqual(
      error.operation,
      operation,
      "error operation mismatch"
    );
    assertConformanceEqual(error.code, code, "error code mismatch");
    assertConformanceEqual(
      error.hostCode,
      hostCode,
      "host error code mismatch"
    );
    return;
  }
  throw new Error(`tuttiExternal conformance: ${operation} must reject.`);
}

async function expectAbortError(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    assertConformance(
      error instanceof Error && error.name === "AbortError",
      "upload aborts must preserve AbortError"
    );
    return;
  }
  throw new Error("tuttiExternal conformance: aborted upload must reject.");
}
