import type {
  DesktopWorkspaceAppContext,
  DesktopWorkspaceAppFileUploadCancelInput,
  DesktopWorkspaceAppFileUploadPrepareInput,
  DesktopWorkspaceAppFileUploadPrepareResult
} from "../../shared/contracts/ipc";
import type {
  TuttiExternalBridge,
  TuttiExternalFileUploadInput,
  TuttiExternalFileUploadProgress,
  TuttiExternalUploadedFile,
  TuttiExternalWorkspaceOpenRouteIntent
} from "@tutti-os/workspace-external-core/contracts";
import {
  normalizeTuttiExternalFileUploadInput,
  tuttiExternalAtProviderIds,
  tuttiExternalManagedAiModelProviderIds,
  tuttiExternalWorkspaceAgentProviders,
  tuttiExternalWorkspaceFeatures
} from "@tutti-os/workspace-external-core/core";
import {
  createTuttiExternalBridge,
  tuttiExternalOperations,
  type TuttiExternalHostAdapter,
  type TuttiExternalHostEvent,
  type TuttiExternalHostEventPayloadMap,
  type TuttiExternalRequestInputMap,
  type TuttiExternalRequestOperation,
  type TuttiExternalRequestResultMap
} from "@tutti-os/workspace-external-core/host";
import type { WorkspaceUserProjectServiceSnapshot } from "@tutti-os/workspace-user-project/contracts";

export interface WorkspaceAppExternalBridgeDependencies {
  appContext: {
    get(): Promise<DesktopWorkspaceAppContext>;
    subscribe(
      listener: (context: DesktopWorkspaceAppContext) => void
    ): () => void;
  };
  createXMLHttpRequest?: () => WorkspaceAppUploadXMLHttpRequest;
  fetch?: typeof fetch;
  invoke<TResult>(channel: string, payload?: unknown): Promise<TResult>;
  isUserActivationActive(): boolean;
  send(channel: string, payload?: unknown): void;
  subscribeToUserProjects?(
    listener: (snapshot: WorkspaceUserProjectServiceSnapshot) => void
  ): () => void;
  subscribeToWorkspaceLaunchIntents?(
    listener: (intent: TuttiExternalWorkspaceOpenRouteIntent) => void
  ): () => void;
}

export interface WorkspaceAppUploadXMLHttpRequest {
  onabort: (() => void) | null;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  status: number;
  upload?: {
    onprogress:
      | ((event: {
          lengthComputable?: boolean;
          loaded: number;
          total?: number;
        }) => void)
      | null;
  };
  abort(): void;
  open(method: string, url: string): void;
  send(body: Blob | File): void;
  setRequestHeader(name: string, value: string): void;
}

export const workspaceAppExternalChannels = {
  activityReportActive: "workspace-app-activity:report-active",
  atQuery: "workspace-app-at:query",
  browserOpenUrl: "workspace-app:open-url",
  filesOpen: "workspace-app-files:open",
  filesSelect: "workspace-app-files:select",
  filesUploadCancel: "workspace-app-files:upload-cancel",
  filesUploadComplete: "workspace-app-files:upload-complete",
  filesUploadPrepare: "workspace-app-files:upload-prepare",
  logsWrite: "workspace-app-logs:write",
  permissionsRequest: "workspace-app-permissions:request",
  pdfPrintHtml: "workspace-app-pdf:print-html",
  referencesOpen: "workspace-app-references:open",
  settingsOpen: "workspace-app-settings:open",
  userProjectsCheckPath: "workspace-app-user-projects:check-path",
  userProjectsCreate: "workspace-app-user-projects:create",
  userProjectsGetDefaultSelection:
    "workspace-app-user-projects:get-default-selection",
  userProjectsGetSnapshot: "workspace-app-user-projects:get-snapshot",
  userProjectsList: "workspace-app-user-projects:list",
  userProjectsPrepareSelection: "workspace-app-user-projects:prepare-selection",
  userProjectsRefresh: "workspace-app-user-projects:refresh",
  userProjectsRememberDefaultSelection:
    "workspace-app-user-projects:remember-default-selection",
  userProjectsSelectDirectory: "workspace-app-user-projects:select-directory",
  userProjectsUse: "workspace-app-user-projects:use",
  workspaceFeatureOpen: "workspace-app-feature:open"
} as const;

export function createWorkspaceAppExternalBridge(
  dependencies: WorkspaceAppExternalBridgeDependencies
): TuttiExternalBridge {
  const adapter = createWorkspaceAppExternalHostAdapter(dependencies);
  return createTuttiExternalBridge({
    adapter,
    isUserActivationActive: dependencies.isUserActivationActive
  });
}

function createWorkspaceAppExternalHostAdapter(
  dependencies: WorkspaceAppExternalBridgeDependencies
): TuttiExternalHostAdapter {
  return {
    capabilities: {
      operations: tuttiExternalOperations,
      atProviders: tuttiExternalAtProviderIds,
      managedAiProviders: tuttiExternalManagedAiModelProviderIds,
      workspaceAgentProviders: tuttiExternalWorkspaceAgentProviders,
      workspaceFeatures: tuttiExternalWorkspaceFeatures
    },
    request(operation, input) {
      return invokeWorkspaceAppExternalRequest(dependencies, operation, input);
    },
    notify(operation, input) {
      const channel =
        operation === "browser.openUrl"
          ? workspaceAppExternalChannels.browserOpenUrl
          : workspaceAppExternalChannels.logsWrite;
      dependencies.send(channel, input);
    },
    openEventStream(operation, listener) {
      return openWorkspaceAppExternalEventStream(
        dependencies,
        operation,
        listener
      );
    },
    upload(file, input) {
      return uploadWorkspaceAppFile(dependencies, file, input);
    }
  };
}

function invokeWorkspaceAppExternalRequest<
  TOperation extends TuttiExternalRequestOperation
>(
  dependencies: WorkspaceAppExternalBridgeDependencies,
  operation: TOperation,
  input: TuttiExternalRequestInputMap[TOperation]
): Promise<TuttiExternalRequestResultMap[TOperation]> {
  if (operation === "app.getContext") {
    return dependencies.appContext.get() as Promise<
      TuttiExternalRequestResultMap[TOperation]
    >;
  }
  const channel =
    workspaceAppExternalRequestChannels[
      operation as Exclude<TuttiExternalRequestOperation, "app.getContext">
    ];
  return dependencies.invoke<TuttiExternalRequestResultMap[TOperation]>(
    channel,
    input
  );
}

const workspaceAppExternalRequestChannels = {
  "activity.reportActive": workspaceAppExternalChannels.activityReportActive,
  "at.query": workspaceAppExternalChannels.atQuery,
  "files.open": workspaceAppExternalChannels.filesOpen,
  "files.select": workspaceAppExternalChannels.filesSelect,
  "pdf.printHtmlToPdf": workspaceAppExternalChannels.pdfPrintHtml,
  "permissions.request": workspaceAppExternalChannels.permissionsRequest,
  "references.open": workspaceAppExternalChannels.referencesOpen,
  "settings.open": workspaceAppExternalChannels.settingsOpen,
  "userProjects.checkPath": workspaceAppExternalChannels.userProjectsCheckPath,
  "userProjects.create": workspaceAppExternalChannels.userProjectsCreate,
  "userProjects.getDefaultSelection":
    workspaceAppExternalChannels.userProjectsGetDefaultSelection,
  "userProjects.getSnapshot":
    workspaceAppExternalChannels.userProjectsGetSnapshot,
  "userProjects.list": workspaceAppExternalChannels.userProjectsList,
  "userProjects.prepareSelection":
    workspaceAppExternalChannels.userProjectsPrepareSelection,
  "userProjects.refresh": workspaceAppExternalChannels.userProjectsRefresh,
  "userProjects.rememberDefaultSelection":
    workspaceAppExternalChannels.userProjectsRememberDefaultSelection,
  "userProjects.selectDirectory":
    workspaceAppExternalChannels.userProjectsSelectDirectory,
  "userProjects.use": workspaceAppExternalChannels.userProjectsUse,
  "workspace.openFeature": workspaceAppExternalChannels.workspaceFeatureOpen
} as const satisfies Record<
  Exclude<TuttiExternalRequestOperation, "app.getContext">,
  string
>;

function openWorkspaceAppExternalEventStream<
  TEvent extends TuttiExternalHostEvent
>(
  dependencies: WorkspaceAppExternalBridgeDependencies,
  event: TEvent,
  listener: (payload: TuttiExternalHostEventPayloadMap[TEvent]) => void
) {
  if (event === "app.contextChanged") {
    return {
      initial: Promise.resolve(undefined),
      unsubscribe: dependencies.appContext.subscribe(
        listener as (context: DesktopWorkspaceAppContext) => void
      )
    };
  }
  if (event === "workspace.launchIntent") {
    return {
      initial: dependencies.appContext
        .get()
        .then((context) => context.launchIntent) as Promise<
        TuttiExternalHostEventPayloadMap[TEvent] | undefined
      >,
      unsubscribe:
        dependencies.subscribeToWorkspaceLaunchIntents?.(
          listener as (intent: TuttiExternalWorkspaceOpenRouteIntent) => void
        ) ?? (() => {})
    };
  }
  return {
    initial: Promise.resolve(undefined),
    unsubscribe:
      dependencies.subscribeToUserProjects?.(
        listener as (snapshot: WorkspaceUserProjectServiceSnapshot) => void
      ) ?? (() => {})
  };
}

async function uploadWorkspaceAppFile(
  dependencies: WorkspaceAppExternalBridgeDependencies,
  file: Blob | File,
  input: TuttiExternalFileUploadInput
): Promise<TuttiExternalUploadedFile> {
  const fileMetadata = normalizeWorkspaceAppUploadFile(file);
  const uploadInput = normalizeTuttiExternalFileUploadInput(input);
  throwIfWorkspaceAppUploadAborted(uploadInput.signal);
  const prepareInput: DesktopWorkspaceAppFileUploadPrepareInput = {
    purpose: uploadInput.purpose,
    name: uploadInput.name ?? fileMetadata.name,
    mimeType: uploadInput.mimeType ?? fileMetadata.mimeType,
    sizeBytes: fileMetadata.sizeBytes
  };
  let prepared: DesktopWorkspaceAppFileUploadPrepareResult | undefined;
  try {
    prepared =
      await dependencies.invoke<DesktopWorkspaceAppFileUploadPrepareResult>(
        workspaceAppExternalChannels.filesUploadPrepare,
        prepareInput
      );
    throwIfWorkspaceAppUploadAborted(uploadInput.signal);
    await uploadWorkspaceAppFileContent(dependencies, prepared, file, {
      onProgress: uploadInput.onProgress,
      signal: uploadInput.signal,
      totalBytes: fileMetadata.sizeBytes
    });
    throwIfWorkspaceAppUploadAborted(uploadInput.signal);
    const uploaded = await dependencies.invoke<TuttiExternalUploadedFile>(
      workspaceAppExternalChannels.filesUploadComplete,
      { uploadId: prepared.uploadId }
    );
    throwIfWorkspaceAppUploadAborted(uploadInput.signal);
    return uploaded;
  } catch (error) {
    if (prepared) {
      await cancelWorkspaceAppUpload(dependencies, prepared.uploadId);
    }
    if (isWorkspaceAppUploadAbortError(error, uploadInput.signal)) {
      throw createWorkspaceAppUploadAbortError();
    }
    throw error;
  }
}

function normalizeWorkspaceAppUploadFile(file: Blob | File): {
  mimeType: string;
  name: string;
  sizeBytes: number;
} {
  const value = file as {
    name?: unknown;
    size?: unknown;
    type?: unknown;
  };
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) {
    throw new Error("files.upload file must be a Blob or File.");
  }
  if (value.size < 0) {
    throw new Error("files.upload file size must not be negative.");
  }
  const name =
    typeof value.name === "string" && value.name.trim() !== ""
      ? value.name.trim()
      : "upload";
  const mimeType =
    typeof value.type === "string" && value.type.trim() !== ""
      ? value.type.trim()
      : "application/octet-stream";
  return {
    mimeType,
    name,
    sizeBytes: value.size
  };
}

interface WorkspaceAppUploadContentOptions {
  onProgress?: (progress: TuttiExternalFileUploadProgress) => void;
  signal?: AbortSignal;
  totalBytes: number;
}

async function uploadWorkspaceAppFileContent(
  dependencies: WorkspaceAppExternalBridgeDependencies,
  prepared: DesktopWorkspaceAppFileUploadPrepareResult,
  file: Blob | File,
  options: WorkspaceAppUploadContentOptions
): Promise<void> {
  const createXMLHttpRequest =
    dependencies.createXMLHttpRequest ??
    createDefaultWorkspaceAppUploadXMLHttpRequest();
  if (options.onProgress && createXMLHttpRequest) {
    return uploadWorkspaceAppFileContentWithXMLHttpRequest(
      createXMLHttpRequest,
      prepared,
      file,
      options
    );
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("files.upload fetch is unavailable.");
  }
  const response = await fetchImpl(prepared.url, {
    body: file,
    headers: prepared.headers,
    method: prepared.method,
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(
      `files.upload content transfer failed with status ${response.status}.`
    );
  }
  reportWorkspaceAppUploadProgress(
    options.onProgress,
    options.totalBytes,
    options.totalBytes
  );
}

function uploadWorkspaceAppFileContentWithXMLHttpRequest(
  createXMLHttpRequest: () => WorkspaceAppUploadXMLHttpRequest,
  prepared: DesktopWorkspaceAppFileUploadPrepareResult,
  file: Blob | File,
  options: WorkspaceAppUploadContentOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfWorkspaceAppUploadAborted(options.signal);
    const request = createXMLHttpRequest();
    const handleAbort = (): void => {
      request.abort();
    };
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", handleAbort);
      if (request.upload) {
        request.upload.onprogress = null;
      }
      request.onload = null;
      request.onerror = null;
      request.onabort = null;
    };

    request.onload = (): void => {
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        reportWorkspaceAppUploadProgress(
          options.onProgress,
          options.totalBytes,
          options.totalBytes
        );
        resolve();
        return;
      }
      reject(
        new Error(
          `files.upload content transfer failed with status ${request.status}.`
        )
      );
    };
    request.onerror = (): void => {
      cleanup();
      reject(new Error("files.upload content transfer failed."));
    };
    request.onabort = (): void => {
      cleanup();
      reject(createWorkspaceAppUploadAbortError());
    };
    if (request.upload) {
      request.upload.onprogress = (event): void => {
        reportWorkspaceAppUploadProgress(
          options.onProgress,
          event.loaded,
          options.totalBytes
        );
      };
    }
    options.signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      request.open(prepared.method, prepared.url);
      for (const [name, value] of Object.entries(prepared.headers)) {
        request.setRequestHeader(name, value);
      }
      request.send(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function createDefaultWorkspaceAppUploadXMLHttpRequest():
  | (() => WorkspaceAppUploadXMLHttpRequest)
  | undefined {
  const requestConstructor = globalThis.XMLHttpRequest;
  if (typeof requestConstructor !== "function") {
    return undefined;
  }
  return () => new requestConstructor() as WorkspaceAppUploadXMLHttpRequest;
}

function reportWorkspaceAppUploadProgress(
  onProgress: ((progress: TuttiExternalFileUploadProgress) => void) | undefined,
  loadedBytes: number,
  totalBytes: number
): void {
  if (!onProgress) {
    return;
  }
  const safeTotalBytes = Math.max(0, totalBytes);
  const safeLoadedBytes = Math.min(Math.max(0, loadedBytes), safeTotalBytes);
  try {
    onProgress({
      loadedBytes: safeLoadedBytes,
      ratio: safeTotalBytes === 0 ? 1 : safeLoadedBytes / safeTotalBytes,
      totalBytes: safeTotalBytes
    });
  } catch {
    // App progress listeners must not break the host upload state machine.
  }
}

async function cancelWorkspaceAppUpload(
  dependencies: WorkspaceAppExternalBridgeDependencies,
  uploadId: string
): Promise<void> {
  const payload: DesktopWorkspaceAppFileUploadCancelInput = { uploadId };
  try {
    await dependencies.invoke<void>(
      workspaceAppExternalChannels.filesUploadCancel,
      payload
    );
  } catch {
    // Cancellation is best-effort cleanup after the app-facing upload already failed.
  }
}

function throwIfWorkspaceAppUploadAborted(
  signal: AbortSignal | undefined
): void {
  if (signal?.aborted) {
    throw createWorkspaceAppUploadAbortError();
  }
}

function isWorkspaceAppUploadAbortError(
  error: unknown,
  signal: AbortSignal | undefined
): boolean {
  if (signal?.aborted) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function createWorkspaceAppUploadAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("files.upload was aborted.", "AbortError");
  }
  const error = new Error("files.upload was aborted.");
  error.name = "AbortError";
  return error;
}
