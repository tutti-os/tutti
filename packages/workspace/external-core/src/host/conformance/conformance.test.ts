import assert from "node:assert/strict";
import test from "node:test";
import { createTuttiExternalBridge } from "../bridge.ts";
import type {
  TuttiExternalHostAdapter,
  TuttiExternalHostEvent,
  TuttiExternalHostEventPayloadMap,
  TuttiExternalNotificationInputMap,
  TuttiExternalNotifyOperation,
  TuttiExternalRequestInputMap,
  TuttiExternalRequestOperation,
  TuttiExternalRequestResultMap
} from "../types.ts";
import { createTuttiExternalConformanceController } from "./controller.ts";
import { tuttiExternalStable26ConformanceCases } from "./cases.ts";
import { tuttiExternalStable26OperationFixtures } from "./fixtures.ts";
import {
  tuttiExternalStable26ConformanceProfile,
  type TuttiExternalStable26ConformanceProfile
} from "./profile.ts";
import type {
  TuttiExternalConformanceController,
  TuttiExternalConformanceDriver,
  TuttiExternalConformanceHostPort,
  TuttiExternalConformanceObservations
} from "./types.ts";
import {
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalOperations,
  tuttiExternalWorkspaceAgentProviders,
  type TuttiExternalFileUploadProgress,
  type TuttiExternalUploadedFile
} from "../../contracts/index.ts";
import { tuttiExternalWorkspaceFeatures } from "../../core/index.ts";

test("publishes an exhaustive fixture for the canonical 26-operation roster", () => {
  assert.equal(
    tuttiExternalStable26ConformanceProfile.capabilities.operations.length,
    26
  );
  assert.deepEqual(
    tuttiExternalStable26ConformanceProfile.capabilities.operations,
    tuttiExternalOperations
  );
  assert.deepEqual(
    Object.keys(tuttiExternalStable26OperationFixtures),
    tuttiExternalStable26ConformanceProfile.capabilities.operations
  );
  assert.deepEqual(
    tuttiExternalStable26ConformanceProfile.capabilities.atProviders,
    tuttiExternalAtProviderIds
  );
  assert.deepEqual(
    tuttiExternalStable26ConformanceProfile.capabilities.workspaceFeatures,
    tuttiExternalWorkspaceFeatures
  );
  assert.deepEqual(
    tuttiExternalStable26ConformanceProfile.capabilities
      .workspaceAgentProviders,
    tuttiExternalWorkspaceAgentProviders
  );
  assert.deepEqual(
    tuttiExternalStable26ConformanceProfile.capabilities.managedAiProviders,
    tuttiExternalManagedAiModelProviderIds
  );
});

test("publishes isolated deeply frozen stable26 fixtures", () => {
  assertDeepFrozen(tuttiExternalStable26OperationFixtures);
  const first =
    tuttiExternalStable26OperationFixtures["pdf.printHtmlToPdf"].result;
  const second =
    tuttiExternalStable26OperationFixtures["pdf.printHtmlToPdf"].result;
  assert.notEqual(first, second);
  assert.notEqual(first.bytes, second.bytes);
  first.bytes[0] = 255;
  assert.deepEqual([...second.bytes], [1, 2, 3]);
});

test("publishes deeply frozen stable26 conformance cases", () => {
  assertDeepFrozen(tuttiExternalStable26ConformanceCases);
  for (const conformanceCase of tuttiExternalStable26ConformanceCases) {
    const run = conformanceCase.run;
    assert.equal(
      Reflect.set(conformanceCase, "run", async () => undefined),
      false
    );
    assert.equal(conformanceCase.run, run);
  }
});

type Assert<TValue extends true> = TValue;
type IsExact<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft
        ? 1
        : 2
      ? true
      : false
    : false;
type _ControllerProfileIsExact = Assert<
  IsExact<
    TuttiExternalConformanceController["profile"],
    TuttiExternalStable26ConformanceProfile
  >
>;

function assertStable26ProfileIsReadonly(
  profile: TuttiExternalStable26ConformanceProfile
): void {
  // @ts-expect-error stable26 capability properties are readonly.
  profile.capabilities.operations = tuttiExternalOperations;
  // @ts-expect-error stable26 capability rosters are readonly tuples.
  profile.capabilities.atProviders[0] = "workspace-app";
}
void assertStable26ProfileIsReadonly;

// @ts-expect-error every stable26 capability roster is required.
const _missingManagedAiRoster: TuttiExternalStable26ConformanceProfile["capabilities"] =
  {
    operations: tuttiExternalStable26ConformanceProfile.capabilities.operations,
    atProviders:
      tuttiExternalStable26ConformanceProfile.capabilities.atProviders,
    workspaceFeatures:
      tuttiExternalStable26ConformanceProfile.capabilities.workspaceFeatures,
    workspaceAgentProviders:
      tuttiExternalStable26ConformanceProfile.capabilities
        .workspaceAgentProviders
  };

const _wrongOperationRoster: TuttiExternalStable26ConformanceProfile["capabilities"] =
  {
    ...tuttiExternalStable26ConformanceProfile.capabilities,
    // @ts-expect-error stable26 preserves the exact 26-operation tuple.
    operations: ["app.getContext"]
  };
void _missingManagedAiRoster;
void _wrongOperationRoster;

test("passes the runner-neutral stable26 suite through a memory transport", async () => {
  const controller =
    createTuttiExternalConformanceController(createMemoryDriver());
  assert.equal(controller.cases.length, 8);
  await controller.runAll();
});

function createMemoryDriver(): TuttiExternalConformanceDriver {
  return {
    createHost() {
      let userActivationActive = false;
      let blockUploadUntilAbort = false;
      let uploadResult: unknown = {
        mimeType: "application/octet-stream",
        name: "upload.bin",
        path: "/uploads/upload.bin",
        sha256: "sha256",
        sizeBytes: 0
      };
      let uploadError: unknown;
      let uploadProgress: readonly TuttiExternalFileUploadProgress[] = [];
      let observations = createEmptyObservations();
      const results = new Map<TuttiExternalRequestOperation, unknown>();
      const requestErrors = new Map<TuttiExternalRequestOperation, unknown>();
      const notificationErrors = new Map<
        TuttiExternalNotifyOperation,
        unknown
      >();
      const initials = new Map<TuttiExternalHostEvent, Promise<unknown>>();
      const listeners = new Map<
        TuttiExternalHostEvent,
        (payload: unknown) => void
      >();
      const uploadTransferWaiters = new Set<() => void>();

      const adapter: TuttiExternalHostAdapter = {
        capabilities: {
          operations: tuttiExternalOperations,
          atProviders: tuttiExternalAtProviderIds,
          managedAiProviders: tuttiExternalManagedAiModelProviderIds,
          workspaceAgentProviders: tuttiExternalWorkspaceAgentProviders,
          workspaceFeatures: tuttiExternalWorkspaceFeatures
        },
        async request<TOperation extends TuttiExternalRequestOperation>(
          operation: TOperation,
          input: TuttiExternalRequestInputMap[TOperation]
        ): Promise<TuttiExternalRequestResultMap[TOperation]> {
          observations.requests.push({ input, operation });
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
        ) {
          observations.notifications.push({ input, operation });
          if (notificationErrors.has(operation)) {
            throw notificationErrors.get(operation);
          }
        },
        openEventStream<TEvent extends TuttiExternalHostEvent>(
          event: TEvent,
          listener: (payload: TuttiExternalHostEventPayloadMap[TEvent]) => void
        ) {
          observations.openedEvents.push(event);
          listeners.set(event, listener as (payload: unknown) => void);
          const stream = {
            initial: (initials.get(event) ??
              Promise.resolve(undefined)) as Promise<
              TuttiExternalHostEventPayloadMap[TEvent] | undefined
            >,
            unsubscribe() {
              listeners.delete(event);
              observations.unsubscribedEvents.push(event);
            }
          };
          return stream;
        },
        async upload(file, input) {
          observations.uploadPhases.push("prepare");
          observations.uploads.push({ file, input });
          observations.uploadPhases.push("transfer");
          for (const resolve of uploadTransferWaiters) {
            resolve();
          }
          uploadTransferWaiters.clear();
          if (uploadError !== undefined) {
            throw uploadError;
          }
          if (blockUploadUntilAbort) {
            await waitForAbort(input.signal);
            blockUploadUntilAbort = false;
            observations.uploadPhases.push("transfer-abort", "cancel");
            throw createAbortError();
          }
          for (const progress of uploadProgress) {
            input.onProgress?.(progress);
          }
          observations.uploadPhases.push("complete");
          return uploadResult as TuttiExternalUploadedFile;
        }
      };

      const port: TuttiExternalConformanceHostPort = {
        blockUploadTransferUntilAbort() {
          blockUploadUntilAbort = true;
        },
        clearNotificationError(operation) {
          notificationErrors.delete(operation);
        },
        clearRequestError(operation) {
          requestErrors.delete(operation);
        },
        clearUploadError() {
          uploadError = undefined;
        },
        emit(event, payload) {
          listeners.get(event)?.(payload);
        },
        getObservations() {
          return observations;
        },
        resetObservations() {
          observations = createEmptyObservations();
        },
        setInitial(event, value) {
          initials.set(event, Promise.resolve(value));
        },
        setNotificationError(operation, error) {
          notificationErrors.set(operation, error);
        },
        setRequestError(operation, error) {
          requestErrors.set(operation, error);
        },
        setRequestResult(operation, result) {
          results.set(operation, result);
        },
        setRawRequestResult(operation, result) {
          results.set(operation, result);
        },
        setRawUploadResult(result) {
          uploadResult = result;
        },
        setUploadError(error) {
          uploadError = error;
        },
        setUploadProgress(progress) {
          uploadProgress = progress;
        },
        setUploadResult(result) {
          uploadResult = result;
        },
        setUserActivationActive(active) {
          userActivationActive = active;
        },
        async settle() {
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        waitForUploadTransfer() {
          if (observations.uploadPhases.includes("transfer")) {
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            uploadTransferWaiters.add(resolve);
          });
        }
      };

      return {
        bridge: createTuttiExternalBridge({
          adapter,
          isUserActivationActive: () => userActivationActive
        }),
        dispose() {
          listeners.clear();
        },
        port
      };
    }
  };
}

function createEmptyObservations(): {
  notifications: Array<
    TuttiExternalConformanceObservations["notifications"][number]
  >;
  openedEvents: TuttiExternalHostEvent[];
  requests: Array<TuttiExternalConformanceObservations["requests"][number]>;
  unsubscribedEvents: TuttiExternalHostEvent[];
  uploadPhases: Array<
    TuttiExternalConformanceObservations["uploadPhases"][number]
  >;
  uploads: Array<TuttiExternalConformanceObservations["uploads"][number]>;
} {
  return {
    notifications: [],
    openedEvents: [],
    requests: [],
    unsubscribedEvents: [],
    uploadPhases: [],
    uploads: []
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createAbortError(): Error {
  return new DOMException("upload aborted", "AbortError");
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob ||
    seen.has(value as object)
  ) {
    return;
  }
  seen.add(value as object);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}
