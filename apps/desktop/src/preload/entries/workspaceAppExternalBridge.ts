import type {
  DesktopWorkspaceAppContext,
  DesktopWorkspaceAppFileUploadCancelInput,
  DesktopWorkspaceAppFileUploadPrepareInput,
  DesktopWorkspaceAppFileUploadPrepareResult
} from "../../shared/contracts/ipc";
import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalAtInvalidation,
  TuttiExternalAtResolveInput,
  TuttiExternalAtResolveResult,
  TuttiExternalAgentActivityActivateSessionInput,
  TuttiExternalAgentActivityActivateSessionResult,
  TuttiExternalAgentActivityCancelTurnInput,
  TuttiExternalAgentActivityCancelTurnResult,
  TuttiExternalAgentActivityComposerOptions,
  TuttiExternalAgentActivityComposerOptionsInput,
  TuttiExternalAgentActivitySendInput,
  TuttiExternalAgentActivitySendResult,
  TuttiExternalAgentActivitySnapshot,
  TuttiExternalAgentTargetCatalog,
  TuttiExternalBridge,
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectInput,
  TuttiExternalFileSelectResult,
  TuttiExternalFileUploadInput,
  TuttiExternalFileUploadProgress,
  TuttiExternalUploadedFile,
  TuttiExternalLogInput,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult,
  TuttiExternalPdfPrintHtmlInput,
  TuttiExternalPdfPrintHtmlResult,
  TuttiExternalReferenceOpenInput,
  TuttiExternalSettingsOpenInput,
  TuttiExternalUserProjectCreateInput,
  TuttiExternalUserProjectPathInput,
  TuttiExternalUserProjectRememberDefaultSelectionInput,
  TuttiExternalWorkspaceOpenRouteIntent,
  TuttiExternalWorkspaceOpenFeatureInput
} from "@tutti-os/workspace-external-core/contracts";
import {
  normalizeTuttiExternalFileUploadInput,
  normalizeTuttiExternalLogInput
} from "@tutti-os/workspace-external-core/core";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectServiceSnapshot
} from "@tutti-os/workspace-user-project/contracts";

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
  subscribeToAtInvalidations?(
    listener: (event: TuttiExternalAtInvalidation) => void
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
  agentActivityActivateSession: "workspace-app-agent-activity:activate-session",
  agentActivityCancelTurn: "workspace-app-agent-activity:cancel-turn",
  agentActivityGetComposerOptions:
    "workspace-app-agent-activity:get-composer-options",
  agentActivityGetSnapshot: "workspace-app-agent-activity:get-snapshot",
  agentActivityListTargets: "workspace-app-agent-activity:list-targets",
  agentActivitySendInput: "workspace-app-agent-activity:send-input",
  atQuery: "workspace-app-at:query",
  atResolve: "workspace-app-at:resolve",
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
  userProjectsMove: "workspace-app-user-projects:move",
  userProjectsPrepareSelection: "workspace-app-user-projects:prepare-selection",
  userProjectsRefresh: "workspace-app-user-projects:refresh",
  userProjectsRememberDefaultSelection:
    "workspace-app-user-projects:remember-default-selection",
  userProjectsSelectDirectory: "workspace-app-user-projects:select-directory",
  userProjectsUse: "workspace-app-user-projects:use",
  workspaceFeatureOpen: "workspace-app-feature:open"
} as const;

const noop = () => {};

export function createWorkspaceAppExternalBridge(
  dependencies: WorkspaceAppExternalBridgeDependencies
): TuttiExternalBridge {
  let initialLaunchIntentConsumed = false;
  return {
    app: {
      getContext() {
        return dependencies.appContext.get();
      },
      subscribe(listener) {
        return dependencies.appContext.subscribe(listener);
      }
    },
    activity: {
      reportActive() {
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.activityReportActive
        );
      }
    },
    agentActivity: {
      activateSession(input: TuttiExternalAgentActivityActivateSessionInput) {
        return dependencies.invoke<TuttiExternalAgentActivityActivateSessionResult>(
          workspaceAppExternalChannels.agentActivityActivateSession,
          input
        );
      },
      cancelTurn(input: TuttiExternalAgentActivityCancelTurnInput) {
        return dependencies.invoke<TuttiExternalAgentActivityCancelTurnResult>(
          workspaceAppExternalChannels.agentActivityCancelTurn,
          input
        );
      },
      getComposerOptions(
        input: TuttiExternalAgentActivityComposerOptionsInput
      ) {
        return dependencies.invoke<TuttiExternalAgentActivityComposerOptions>(
          workspaceAppExternalChannels.agentActivityGetComposerOptions,
          input
        );
      },
      getSnapshot() {
        return dependencies.invoke<TuttiExternalAgentActivitySnapshot>(
          workspaceAppExternalChannels.agentActivityGetSnapshot
        );
      },
      listTargets() {
        return dependencies.invoke<TuttiExternalAgentTargetCatalog>(
          workspaceAppExternalChannels.agentActivityListTargets
        );
      },
      sendInput(input: TuttiExternalAgentActivitySendInput) {
        return dependencies.invoke<TuttiExternalAgentActivitySendResult>(
          workspaceAppExternalChannels.agentActivitySendInput,
          input
        );
      }
    },
    browser: {
      openUrl(input) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "browser.openUrl"
        );
        dependencies.send(workspaceAppExternalChannels.browserOpenUrl, input);
        return Promise.resolve();
      }
    },
    at: {
      query(input: TuttiExternalAtQueryInput) {
        return dependencies.invoke<TuttiExternalAtQueryResult[]>(
          workspaceAppExternalChannels.atQuery,
          input
        );
      },
      resolve(input: TuttiExternalAtResolveInput) {
        return dependencies.invoke<TuttiExternalAtResolveResult | null>(
          workspaceAppExternalChannels.atResolve,
          input
        );
      },
      subscribe(listener) {
        return dependencies.subscribeToAtInvalidations?.(listener) ?? noop;
      }
    },
    files: {
      select(input?: TuttiExternalFileSelectInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "files.select"
        );
        return dependencies.invoke<TuttiExternalFileSelectResult>(
          workspaceAppExternalChannels.filesSelect,
          input ?? {}
        );
      },
      open(input: TuttiExternalFileOpenInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "files.open"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.filesOpen,
          input
        );
      },
      async upload(file: Blob | File, input?: TuttiExternalFileUploadInput) {
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
    },
    permissions: {
      request(input: TuttiExternalPermissionRequestInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "permissions.request"
        );
        return dependencies.invoke<TuttiExternalPermissionRequestResult>(
          workspaceAppExternalChannels.permissionsRequest,
          input
        );
      }
    },
    settings: {
      open(input?: TuttiExternalSettingsOpenInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "settings.open"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.settingsOpen,
          input ?? {}
        );
      }
    },
    references: {
      open(input: TuttiExternalReferenceOpenInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "references.open"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.referencesOpen,
          input
        );
      }
    },
    // Workspace apps are trusted installed packages. User activation gates
    // disruptive host UI, not the trusted project-state integration surface.
    userProjects: {
      checkPath(input: TuttiExternalUserProjectPathInput) {
        return dependencies.invoke<WorkspaceUserProjectPathCheck>(
          workspaceAppExternalChannels.userProjectsCheckPath,
          input
        );
      },
      create(input: TuttiExternalUserProjectCreateInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "userProjects.create"
        );
        return dependencies.invoke<WorkspaceUserProject>(
          workspaceAppExternalChannels.userProjectsCreate,
          input
        );
      },
      getDefaultSelection() {
        return dependencies.invoke<WorkspaceUserProjectDefaultSelection | null>(
          workspaceAppExternalChannels.userProjectsGetDefaultSelection
        );
      },
      getSnapshot() {
        return dependencies.invoke<WorkspaceUserProjectServiceSnapshot>(
          workspaceAppExternalChannels.userProjectsGetSnapshot
        );
      },
      list() {
        return dependencies.invoke<{ projects: WorkspaceUserProject[] }>(
          workspaceAppExternalChannels.userProjectsList
        );
      },
      move(input) {
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.userProjectsMove,
          input
        );
      },
      prepareSelection(input: WorkspaceUserProjectSelectionPreparationInput) {
        return dependencies.invoke<WorkspaceUserProjectSelectionPreparation>(
          workspaceAppExternalChannels.userProjectsPrepareSelection,
          input
        );
      },
      refresh() {
        return dependencies.invoke<WorkspaceUserProjectServiceSnapshot>(
          workspaceAppExternalChannels.userProjectsRefresh
        );
      },
      rememberDefaultSelection(
        input: TuttiExternalUserProjectRememberDefaultSelectionInput
      ) {
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.userProjectsRememberDefaultSelection,
          input
        );
      },
      selectDirectory() {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "userProjects.selectDirectory"
        );
        return dependencies.invoke<{ path: string } | null>(
          workspaceAppExternalChannels.userProjectsSelectDirectory
        );
      },
      subscribe(listener) {
        return dependencies.subscribeToUserProjects?.(listener) ?? (() => {});
      },
      use(input: TuttiExternalUserProjectPathInput) {
        return dependencies.invoke<WorkspaceUserProject>(
          workspaceAppExternalChannels.userProjectsUse,
          input
        );
      }
    },
    workspace: {
      onLaunchIntent(listener) {
        let active = true;
        const unsubscribe =
          dependencies.subscribeToWorkspaceLaunchIntents?.(listener) ?? noop;
        void dependencies.appContext
          .get()
          .then((context) => {
            if (
              active &&
              context.launchIntent &&
              !initialLaunchIntentConsumed
            ) {
              initialLaunchIntentConsumed = true;
              listener(context.launchIntent);
            }
          })
          .catch(() => {});
        return () => {
          active = false;
          unsubscribe();
        };
      },
      openFeature(input: TuttiExternalWorkspaceOpenFeatureInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "workspace.openFeature"
        );
        return dependencies.invoke<void>(
          workspaceAppExternalChannels.workspaceFeatureOpen,
          input
        );
      }
    },
    pdf: {
      printHtmlToPdf(input: TuttiExternalPdfPrintHtmlInput) {
        requireUserActivation(
          dependencies.isUserActivationActive(),
          "pdf.printHtmlToPdf"
        );
        return dependencies.invoke<TuttiExternalPdfPrintHtmlResult>(
          workspaceAppExternalChannels.pdfPrintHtml,
          input
        );
      }
    },
    logs: {
      write(input: TuttiExternalLogInput) {
        try {
          dependencies.send(
            workspaceAppExternalChannels.logsWrite,
            normalizeTuttiExternalLogInput(input)
          );
        } catch {
          // Fire-and-forget: invalid app payloads are silently ignored.
        }
      }
    }
  };
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

export function requireUserActivation(
  isActive: boolean,
  operation: string
): void {
  if (!isActive) {
    throw new Error(`${operation} requires a user action.`);
  }
}
