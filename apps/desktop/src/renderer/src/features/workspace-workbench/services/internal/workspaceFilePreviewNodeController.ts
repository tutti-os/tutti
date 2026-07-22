import {
  createWorkspaceFilePreviewController,
  formatWorkspacePreviewByteLimit,
  isTextDegradablePreviewKind,
  workspaceFilePreviewMaxBytes,
  type WorkspaceFilePreviewController,
  type WorkspaceFilePreviewControllerState,
  type WorkspaceFilePreviewTarget,
  type WorkspaceFilePreviewReadonlyReason
} from "@tutti-os/workspace-file-preview";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { DesktopHostFilesApi } from "@preload/types";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import { workspaceWorkbenchDesktopI18nKeys } from "@shared/i18n";
import {
  createWorkspaceFilePreviewNodeRuntimeState,
  createWorkspaceFilePreviewNodeSnapshotState,
  workspaceFilePreviewNodeFileKey,
  type WorkspaceFilePreviewTextHeaderState
} from "../../ui/workspaceFilePreviewNodeState.ts";
import { saveWorkspaceFilePreviewText } from "./workspaceFilePreviewTextSave.ts";

export type WorkspaceFilePreviewTextSaveStatus =
  | "error"
  | "idle"
  | "saved"
  | "saving";

export type WorkspaceFilePreviewNodeControllerState =
  | { status: "empty" }
  | { entry: WorkspaceFilePreviewTarget; status: "loading" }
  | {
      content: string;
      draft: string;
      entry: WorkspaceFilePreviewTarget;
      message?: string;
      saveStatus: WorkspaceFilePreviewTextSaveStatus;
      status: "text";
    }
  | {
      entry: WorkspaceFilePreviewTarget;
      objectUrl: string;
      status: "image";
    }
  | {
      entry: WorkspaceFilePreviewTarget;
      objectUrl: string;
      status: "video";
    }
  | {
      entry: WorkspaceFilePreviewTarget;
      message: string;
      status: "error";
    }
  | {
      entry: WorkspaceFilePreviewTarget;
      message: string;
      status: "readonly";
    }
  | {
      entry: WorkspaceFilePreviewTarget;
      message: string;
      status: "unsupported";
    };

export interface WorkspaceFilePreviewNodeController {
  changeDraft(draft: string): void;
  dispose(): void;
  getSnapshot(): WorkspaceFilePreviewNodeControllerState;
  saveTextFile(): Promise<void>;
  setActiveFile(file: WorkspaceFilePreviewTarget | null): void;
  subscribe(listener: () => void): () => void;
}

export function createWorkspaceFilePreviewNodeController(input: {
  appI18n: I18nRuntime<string>;
  hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  initialFile: WorkspaceFilePreviewTarget | null;
  tuttidClient: Pick<
    TuttidClient,
    "readWorkspaceFilePreview" | "writeWorkspaceFileText"
  >;
  onRuntimeStateChange(state: unknown): void;
  onSnapshotStateChange(state: unknown): void;
  workspaceID: string;
}): WorkspaceFilePreviewNodeController {
  return new WorkspaceFilePreviewNodeControllerImpl(input);
}

class WorkspaceFilePreviewNodeControllerImpl implements WorkspaceFilePreviewNodeController {
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly input: {
    appI18n: I18nRuntime<string>;
    hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
    i18n: WorkspaceWorkbenchDesktopI18nRuntime;
    initialFile: WorkspaceFilePreviewTarget | null;
    tuttidClient: Pick<
      TuttidClient,
      "readWorkspaceFilePreview" | "writeWorkspaceFileText"
    >;
    onRuntimeStateChange(state: unknown): void;
    onSnapshotStateChange(state: unknown): void;
    workspaceID: string;
  };
  private readonly previewController: WorkspaceFilePreviewController<WorkspaceFilePreviewTarget>;
  private readonly unsubscribePreview: () => void;
  private runtimeStateKey: string | null = null;
  private snapshotStateKey: string | null = null;
  private state: WorkspaceFilePreviewNodeControllerState;

  constructor(input: {
    appI18n: I18nRuntime<string>;
    hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
    i18n: WorkspaceWorkbenchDesktopI18nRuntime;
    initialFile: WorkspaceFilePreviewTarget | null;
    tuttidClient: Pick<
      TuttidClient,
      "readWorkspaceFilePreview" | "writeWorkspaceFileText"
    >;
    onRuntimeStateChange(state: unknown): void;
    onSnapshotStateChange(state: unknown): void;
    workspaceID: string;
  }) {
    this.input = input;
    this.state = input.initialFile
      ? { entry: input.initialFile, status: "loading" }
      : { status: "empty" };
    this.previewController = createWorkspaceFilePreviewController({
      canReadEntry: () => true,
      getEntryKey: workspaceFilePreviewNodeFileKey,
      read: async ({ entry }) => ({
        bytes: isAbsoluteFilesystemPath(entry.path)
          ? await input.hostFilesApi.readLocalPreviewFile(entry.path)
          : decodeBase64Bytes(
              (
                await input.tuttidClient.readWorkspaceFilePreview(
                  input.workspaceID,
                  entry.path
                )
              ).bytesBase64
            ),
        kind: entry.previewKind
      }),
      toPreviewEntry: (entry: WorkspaceFilePreviewTarget) => ({
        ...entry,
        kind: "file"
      })
    });
    this.unsubscribePreview = this.previewController.subscribe(() => {
      this.applyPreviewState(this.previewController.getSnapshot());
    });
  }

  changeDraft(draft: string): void {
    this.updateState((current) =>
      current.status === "text"
        ? {
            ...current,
            draft,
            message: undefined,
            saveStatus: current.saveStatus === "saving" ? "saving" : "idle"
          }
        : current
    );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribePreview();
    this.previewController.dispose();
    this.listeners.clear();
  }

  getSnapshot(): WorkspaceFilePreviewNodeControllerState {
    return this.state;
  }

  async saveTextFile(): Promise<void> {
    if (this.state.status !== "text") {
      return;
    }

    const target = this.state.entry;
    const targetKey = workspaceFilePreviewNodeFileKey(target);
    const content = this.state.draft;

    this.updateState((current) =>
      current.status === "text" &&
      workspaceFilePreviewNodeFileKey(current.entry) === targetKey
        ? { ...current, message: undefined, saveStatus: "saving" }
        : current
    );

    try {
      await saveWorkspaceFilePreviewText({
        content,
        path: target.path,
        tuttidClient: this.input.tuttidClient,
        workspaceID: this.input.workspaceID
      });
      this.updateState((current) =>
        current.status === "text" &&
        workspaceFilePreviewNodeFileKey(current.entry) === targetKey
          ? {
              ...current,
              content,
              draft: content,
              message: undefined,
              saveStatus: "saved"
            }
          : current
      );
    } catch {
      this.updateState((current) =>
        current.status === "text" &&
        workspaceFilePreviewNodeFileKey(current.entry) === targetKey
          ? {
              ...current,
              message: this.input.i18n.t(
                workspaceWorkbenchDesktopI18nKeys.filePreview.saveFailed
              ),
              saveStatus: "error"
            }
          : current
      );
    }
  }

  setActiveFile(file: WorkspaceFilePreviewTarget | null): void {
    if (this.disposed) {
      return;
    }
    void this.previewController.setEntry(file);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private applyPreviewState(
    state: WorkspaceFilePreviewControllerState<WorkspaceFilePreviewTarget>
  ): void {
    switch (state.status) {
      case "empty":
        this.updateState(() => state);
        return;
      case "loading":
        this.updateState(() => state);
        return;
      case "text":
        this.updateState(() => ({
          content: state.content,
          draft: state.content,
          entry: state.entry,
          saveStatus: "idle",
          status: "text"
        }));
        return;
      case "image":
      case "video":
        this.updateState(() => ({
          entry: state.entry,
          objectUrl: state.objectUrl,
          status: state.status
        }));
        return;
      case "bytes":
        // Desktop workbench does not register host renderers yet; hook-only
        // payloads are treated as unsupported in this surface.
        this.updateState(() => ({
          entry: state.entry,
          message: this.input.appI18n.t(
            "workspaceFileManager.previewUnsupported"
          ),
          status: "unsupported"
        }));
        return;
      case "readonly":
        this.updateState(() => ({
          entry: state.entry,
          message: resolveReadonlyMessage(
            this.input.appI18n,
            state.reason,
            state.maxSizeBytes
          ),
          status: "readonly"
        }));
        return;
      case "directory":
      case "unsupported":
        this.updateState(() => ({
          entry: state.entry,
          message: this.input.appI18n.t(
            "workspaceFileManager.previewUnsupported"
          ),
          status: "unsupported"
        }));
        return;
      case "error":
        this.updateState(() => ({
          entry: state.entry,
          message: this.input.appI18n.t(
            "workspaceFileManager.unknownErrorMessage"
          ),
          status: "error"
        }));
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private publishNodeState(): void {
    const runtimeState = resolveRuntimeStateFromPreviewState(this.state);
    const runtimeStateKey = nodeStateKey(runtimeState);
    if (this.runtimeStateKey !== runtimeStateKey) {
      this.runtimeStateKey = runtimeStateKey;
      this.input.onRuntimeStateChange(runtimeState);
    }

    const snapshotState = resolveSnapshotStateFromPreviewState(this.state);
    const snapshotStateKey = nodeStateKey(snapshotState);
    if (this.snapshotStateKey !== snapshotStateKey) {
      this.snapshotStateKey = snapshotStateKey;
      this.input.onSnapshotStateChange(snapshotState);
    }
  }

  private updateState(
    update: (
      current: WorkspaceFilePreviewNodeControllerState
    ) => WorkspaceFilePreviewNodeControllerState
  ): void {
    if (this.disposed) {
      return;
    }
    this.state = update(this.state);
    this.publishNodeState();
    this.emit();
  }
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function resolveRuntimeStateFromPreviewState(
  state: WorkspaceFilePreviewNodeControllerState
): ReturnType<typeof createWorkspaceFilePreviewNodeRuntimeState> | undefined {
  if (state.status === "empty") {
    return undefined;
  }

  return createWorkspaceFilePreviewNodeRuntimeState({
    file: state.entry,
    textHeader: isTextDegradablePreviewKind(state.entry.previewKind)
      ? resolveTextHeaderStateFromPreviewState(state)
      : undefined
  });
}

function resolveSnapshotStateFromPreviewState(
  state: WorkspaceFilePreviewNodeControllerState
): ReturnType<typeof createWorkspaceFilePreviewNodeSnapshotState> | undefined {
  if (state.status === "empty") {
    return undefined;
  }

  return createWorkspaceFilePreviewNodeSnapshotState({
    file: state.entry
  });
}

function nodeStateKey(state: unknown): string {
  return state === undefined ? "__undefined__" : JSON.stringify(state);
}

function resolveTextHeaderStateFromPreviewState(
  state: Exclude<WorkspaceFilePreviewNodeControllerState, { status: "empty" }>
): WorkspaceFilePreviewTextHeaderState {
  if (state.status === "loading") {
    return {
      canSave: false,
      dirty: false,
      status: "loading"
    };
  }

  if (state.status !== "text") {
    return {
      canSave: false,
      dirty: false,
      message:
        state.status === "error" ||
        state.status === "readonly" ||
        state.status === "unsupported"
          ? state.message
          : undefined,
      status: "error"
    };
  }

  const dirty = state.draft !== state.content;
  if (state.saveStatus === "saving") {
    return {
      canSave: true,
      dirty,
      status: "saving"
    };
  }
  if (state.saveStatus === "error") {
    return {
      canSave: true,
      dirty,
      message: state.message,
      status: "error"
    };
  }
  if (dirty) {
    return {
      canSave: true,
      dirty: true,
      status: "unsaved"
    };
  }
  return {
    canSave: true,
    dirty: false,
    status: "saved"
  };
}

function resolveReadonlyMessage(
  appI18n: I18nRuntime<string>,
  reason: WorkspaceFilePreviewReadonlyReason,
  maxSizeBytes?: number
): string {
  switch (reason) {
    case "binary":
      return appI18n.t("workspaceFileManager.previewBinary");
    case "decode_failed":
      return appI18n.t("workspaceFileManager.previewDecodeFailed");
    case "file_too_large":
      return appI18n.t("workspaceFileManager.previewFileTooLarge", {
        maxSize: formatWorkspacePreviewByteLimit(
          maxSizeBytes ?? workspaceFilePreviewMaxBytes
        )
      });
    case "text_too_large":
      return appI18n.t("workspaceFileManager.previewTooLarge", {
        maxSize: formatWorkspacePreviewByteLimit(maxSizeBytes ?? 0)
      });
  }
}

function isAbsoluteFilesystemPath(path: string): boolean {
  const trimmed = path.trim();
  return (
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\")
  );
}
