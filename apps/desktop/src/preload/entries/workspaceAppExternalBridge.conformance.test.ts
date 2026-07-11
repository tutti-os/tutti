import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttiExternalFileUploadProgress,
  TuttiExternalUploadedFile
} from "@tutti-os/workspace-external-core/contracts";
import type {
  TuttiExternalHostEvent,
  TuttiExternalHostEventPayloadMap,
  TuttiExternalNotifyOperation,
  TuttiExternalRequestOperation
} from "@tutti-os/workspace-external-core/host";
import {
  createTuttiExternalConformanceController,
  type TuttiExternalConformanceDriver,
  type TuttiExternalConformanceHostPort,
  type TuttiExternalConformanceObservations
} from "@tutti-os/workspace-external-core/host/conformance";
import type { DesktopWorkspaceAppContext } from "../../shared/contracts/ipc.ts";
import {
  createWorkspaceAppExternalBridge,
  workspaceAppExternalChannels,
  type WorkspaceAppUploadXMLHttpRequest
} from "./workspaceAppExternalBridge.ts";

const requestOperationByChannel = new Map<
  string,
  Exclude<TuttiExternalRequestOperation, "app.getContext">
>([
  [workspaceAppExternalChannels.activityReportActive, "activity.reportActive"],
  [workspaceAppExternalChannels.atQuery, "at.query"],
  [workspaceAppExternalChannels.filesOpen, "files.open"],
  [workspaceAppExternalChannels.filesSelect, "files.select"],
  [workspaceAppExternalChannels.permissionsRequest, "permissions.request"],
  [workspaceAppExternalChannels.settingsOpen, "settings.open"],
  [workspaceAppExternalChannels.workspaceFeatureOpen, "workspace.openFeature"],
  [workspaceAppExternalChannels.referencesOpen, "references.open"],
  [workspaceAppExternalChannels.pdfPrintHtml, "pdf.printHtmlToPdf"],
  [
    workspaceAppExternalChannels.userProjectsCheckPath,
    "userProjects.checkPath"
  ],
  [workspaceAppExternalChannels.userProjectsCreate, "userProjects.create"],
  [
    workspaceAppExternalChannels.userProjectsGetDefaultSelection,
    "userProjects.getDefaultSelection"
  ],
  [
    workspaceAppExternalChannels.userProjectsGetSnapshot,
    "userProjects.getSnapshot"
  ],
  [workspaceAppExternalChannels.userProjectsList, "userProjects.list"],
  [
    workspaceAppExternalChannels.userProjectsPrepareSelection,
    "userProjects.prepareSelection"
  ],
  [workspaceAppExternalChannels.userProjectsRefresh, "userProjects.refresh"],
  [
    workspaceAppExternalChannels.userProjectsRememberDefaultSelection,
    "userProjects.rememberDefaultSelection"
  ],
  [
    workspaceAppExternalChannels.userProjectsSelectDirectory,
    "userProjects.selectDirectory"
  ],
  [workspaceAppExternalChannels.userProjectsUse, "userProjects.use"]
]);

const notificationOperationByChannel = new Map<
  string,
  TuttiExternalNotifyOperation
>([
  [workspaceAppExternalChannels.browserOpenUrl, "browser.openUrl"],
  [workspaceAppExternalChannels.logsWrite, "logs.write"]
]);

test("Tutti workspace app factory passes the shared stable26 conformance suite", async (t) => {
  const productHarness = createTuttiProductConformanceDriver();
  const controller = createTuttiExternalConformanceController(
    productHarness.driver
  );

  for (const conformanceCase of controller.cases) {
    await t.test(conformanceCase.title, () =>
      controller.runCase(conformanceCase)
    );
  }

  assert.equal(controller.cases.length, 8);
  assert.equal(productHarness.uploadLifecycle.prepare > 0, true);
  assert.equal(productHarness.uploadLifecycle.transfer > 0, true);
  assert.equal(productHarness.uploadLifecycle.complete > 0, true);
});

function createTuttiProductConformanceDriver(): {
  driver: TuttiExternalConformanceDriver;
  uploadLifecycle: { complete: number; prepare: number; transfer: number };
} {
  const uploadLifecycle = { complete: 0, prepare: 0, transfer: 0 };
  return {
    uploadLifecycle,
    driver: {
      createHost() {
        let userActivationActive = false;
        let blockUploadTransferUntilAbort = false;
        let observations = createEmptyObservations();
        let uploadError: unknown;
        let uploadProgress: readonly TuttiExternalFileUploadProgress[] = [];
        let uploadResult: unknown = createDefaultUploadedFile();
        let pendingUpload:
          | {
              mimeType: string;
              name: string;
              purpose: "app-asset";
              sizeBytes: number;
            }
          | undefined;
        let launchInitial:
          | Promise<
              | TuttiExternalHostEventPayloadMap["workspace.launchIntent"]
              | undefined
            >
          | undefined;
        let launchInitialConfigured = false;
        const results = new Map<TuttiExternalRequestOperation, unknown>();
        const requestErrors = new Map<TuttiExternalRequestOperation, unknown>();
        const notificationErrors = new Map<
          TuttiExternalNotifyOperation,
          unknown
        >();
        const eventTransports = new Map<
          TuttiExternalHostEvent,
          ReturnType<typeof createEventTransport>
        >();
        const uploadTransferWaiters = new Set<() => void>();

        function observeUploadTransfer(): void {
          observations.uploadPhases.push("transfer");
          for (const resolve of uploadTransferWaiters) {
            resolve();
          }
          uploadTransferWaiters.clear();
        }

        function getEventTransport<TEvent extends TuttiExternalHostEvent>(
          event: TEvent
        ): ReturnType<typeof createEventTransport<TEvent>> {
          let transport = eventTransports.get(event);
          if (!transport) {
            transport = createEventTransport<TEvent>();
            eventTransports.set(event, transport);
          }
          return transport as ReturnType<typeof createEventTransport<TEvent>>;
        }

        const bridge = createWorkspaceAppExternalBridge({
          appContext: {
            async get() {
              if (launchInitialConfigured) {
                launchInitialConfigured = false;
                const launchIntent = await launchInitial;
                return {
                  appId: "fixture-app",
                  ...(launchIntent === undefined ? {} : { launchIntent }),
                  locale: "en",
                  workspaceId: "fixture-workspace"
                };
              }
              observations.requests.push({
                input: undefined,
                operation: "app.getContext"
              });
              if (requestErrors.has("app.getContext")) {
                throw requestErrors.get("app.getContext");
              }
              return results.get(
                "app.getContext"
              ) as DesktopWorkspaceAppContext;
            },
            subscribe(listener) {
              return getEventTransport("app.contextChanged").subscribe(
                listener as (payload: unknown) => void
              );
            }
          },
          createXMLHttpRequest: () =>
            createUploadXMLHttpRequest({
              isBlockedUntilAbort: () => blockUploadTransferUntilAbort,
              getPendingUpload: () => pendingUpload,
              onAbort() {
                blockUploadTransferUntilAbort = false;
                observations.uploadPhases.push("transfer-abort");
              },
              onTransfer(file, input) {
                observeUploadTransfer();
                observations.uploads.push({ file, input });
                uploadLifecycle.transfer += 1;
              },
              progress: uploadProgress
            }),
          async fetch(_url, init) {
            const file = init?.body;
            if (!(file instanceof Blob)) {
              throw new Error("conformance upload body must be a Blob");
            }
            observeUploadTransfer();
            observations.uploads.push({
              file,
              input: createObservedUploadInput(pendingUpload)
            });
            uploadLifecycle.transfer += 1;
            return { ok: true, status: 200 } as Response;
          },
          async invoke<TResult>(channel: string, payload?: unknown) {
            if (channel === workspaceAppExternalChannels.filesUploadPrepare) {
              observations.uploadPhases.push("prepare");
              uploadLifecycle.prepare += 1;
              if (uploadError !== undefined) {
                throw uploadError;
              }
              pendingUpload = payload as typeof pendingUpload;
              return {
                headers: { "content-type": pendingUpload?.mimeType ?? "" },
                method: "PUT",
                uploadId: "upload-1",
                url: "https://uploads.invalid/upload-1"
              } as TResult;
            }
            if (channel === workspaceAppExternalChannels.filesUploadComplete) {
              observations.uploadPhases.push("complete");
              uploadLifecycle.complete += 1;
              return uploadResult as TResult;
            }
            if (channel === workspaceAppExternalChannels.filesUploadCancel) {
              observations.uploadPhases.push("cancel");
              return undefined as TResult;
            }
            const operation = requestOperationByChannel.get(channel);
            if (!operation) {
              throw new Error(`unexpected workspace app channel: ${channel}`);
            }
            observations.requests.push({ input: payload, operation });
            if (requestErrors.has(operation)) {
              throw requestErrors.get(operation);
            }
            return results.get(operation) as TResult;
          },
          isUserActivationActive: () => userActivationActive,
          send(channel, payload) {
            const operation = notificationOperationByChannel.get(channel);
            if (!operation) {
              throw new Error(
                `unexpected workspace app send channel: ${channel}`
              );
            }
            observations.notifications.push({ input: payload, operation });
            if (notificationErrors.has(operation)) {
              throw notificationErrors.get(operation);
            }
          },
          subscribeToUserProjects(listener) {
            return getEventTransport("userProjects.changed").subscribe(
              listener
            );
          },
          subscribeToWorkspaceLaunchIntents(listener) {
            observations.openedEvents.push("workspace.launchIntent");
            const transport = getEventTransport("workspace.launchIntent");
            transport.setListener(listener);
            transport.startLive();
            return () => {
              transport.clearListener();
              observations.unsubscribedEvents.push("workspace.launchIntent");
            };
          }
        });

        const port: TuttiExternalConformanceHostPort = {
          blockUploadTransferUntilAbort() {
            blockUploadTransferUntilAbort = true;
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
            getEventTransport(event).emit(payload);
          },
          getObservations() {
            return observations;
          },
          resetObservations() {
            observations = createEmptyObservations();
          },
          setInitial(event, value) {
            if (event === "workspace.launchIntent") {
              launchInitial = Promise.resolve(value) as typeof launchInitial;
              launchInitialConfigured = true;
              return;
            }
            getEventTransport(event).setInitial(Promise.resolve(value));
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

        for (const event of [
          "app.contextChanged",
          "userProjects.changed"
        ] as const) {
          getEventTransport(event).onOpen = () => {
            observations.openedEvents.push(event);
          };
          getEventTransport(event).onClose = () => {
            observations.unsubscribedEvents.push(event);
          };
        }

        return {
          bridge,
          dispose() {
            for (const transport of eventTransports.values()) {
              transport.clearListener();
            }
          },
          port
        };
      }
    }
  };
}

function createEventTransport<TEvent extends TuttiExternalHostEvent>() {
  type Payload = TuttiExternalHostEventPayloadMap[TEvent];
  let initial: Promise<Payload | undefined> = Promise.resolve(undefined);
  let initialDelivered = false;
  let listener: ((payload: Payload) => void) | undefined;
  const queued: Payload[] = [];
  const transport = {
    onClose: undefined as (() => void) | undefined,
    onOpen: undefined as (() => void) | undefined,
    clearListener() {
      listener = undefined;
      queued.splice(0);
    },
    emit(payload: Payload) {
      if (!initialDelivered) {
        queued.push(payload);
        return;
      }
      listener?.(payload);
    },
    setInitial(value: Promise<Payload | undefined>) {
      initial = value;
      initialDelivered = false;
      queued.splice(0);
    },
    setListener(nextListener: (payload: Payload) => void) {
      listener = nextListener;
    },
    startLive() {
      initialDelivered = true;
      for (const payload of queued.splice(0)) {
        listener?.(payload);
      }
    },
    subscribe(nextListener: (payload: Payload) => void) {
      listener = nextListener;
      transport.onOpen?.();
      void initial.then((value) => {
        if (value !== undefined) {
          listener?.(value);
        }
        initialDelivered = true;
        for (const payload of queued.splice(0)) {
          listener?.(payload);
        }
      });
      return () => {
        transport.clearListener();
        transport.onClose?.();
      };
    }
  };
  return transport;
}

function createUploadXMLHttpRequest(options: {
  isBlockedUntilAbort(): boolean;
  getPendingUpload():
    | {
        mimeType: string;
        name: string;
        purpose: "app-asset";
        sizeBytes: number;
      }
    | undefined;
  onTransfer(
    file: Blob,
    input: ReturnType<typeof createObservedUploadInput>
  ): void;
  onAbort(): void;
  progress: readonly TuttiExternalFileUploadProgress[];
}): WorkspaceAppUploadXMLHttpRequest {
  const request: WorkspaceAppUploadXMLHttpRequest = {
    onabort: null,
    onerror: null,
    onload: null,
    status: 200,
    upload: { onprogress: null },
    abort() {
      options.onAbort();
      request.onabort?.();
    },
    open() {},
    send(file) {
      options.onTransfer(
        file,
        createObservedUploadInput(options.getPendingUpload())
      );
      if (options.isBlockedUntilAbort()) {
        return;
      }
      for (const progress of options.progress) {
        if (progress.loadedBytes < progress.totalBytes) {
          request.upload?.onprogress?.({
            lengthComputable: true,
            loaded: progress.loadedBytes,
            total: progress.totalBytes
          });
        }
      }
      request.onload?.();
    },
    setRequestHeader() {}
  };
  return request;
}

function createObservedUploadInput(
  pending:
    | {
        mimeType: string;
        name: string;
        purpose: "app-asset";
        sizeBytes: number;
      }
    | undefined
): {
  mimeType: string;
  name: string;
  purpose: "app-asset";
} {
  if (!pending) {
    throw new Error("upload transfer must follow prepare");
  }
  return {
    mimeType: pending.mimeType,
    name: pending.name,
    purpose: pending.purpose
  };
}

function createDefaultUploadedFile(): TuttiExternalUploadedFile {
  return {
    mimeType: "application/octet-stream",
    name: "upload.bin",
    path: "/uploads/upload.bin",
    sha256: "sha256",
    sizeBytes: 0
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
