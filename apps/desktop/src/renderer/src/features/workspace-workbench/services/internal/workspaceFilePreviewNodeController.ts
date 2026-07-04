import type { WorkspaceFileActivationTarget } from "@tutti-os/workspace-file-manager/services";
import {
  createWorkspaceFilePreviewLoadedState,
  formatWorkspacePreviewByteLimit,
  normalizeWorkspaceFilePreviewBytes,
  workspaceFilePreviewMaxBytes,
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
  | { entry: WorkspaceFileActivationTarget; status: "loading" }
  | {
      content: string;
      draft: string;
      entry: WorkspaceFileActivationTarget;
      message?: string;
      saveStatus: WorkspaceFilePreviewTextSaveStatus;
      status: "text";
    }
  | {
      entry: WorkspaceFileActivationTarget;
      objectUrl: string;
      status: "image";
    }
  | {
      entry: WorkspaceFileActivationTarget;
      objectUrl: string;
      status: "video";
    }
  | { entry: WorkspaceFileActivationTarget; message: string; status: "error" }
  | {
      entry: WorkspaceFileActivationTarget;
      message: string;
      status: "readonly";
    }
  | {
      entry: WorkspaceFileActivationTarget;
      message: string;
      status: "unsupported";
    };

export interface WorkspaceFilePreviewNodeController {
  changeDraft(draft: string): void;
  dispose(): void;
  getSnapshot(): WorkspaceFilePreviewNodeControllerState;
  saveTextFile(): Promise<void>;
  setActiveFile(file: WorkspaceFileActivationTarget | null): void;
  subscribe(listener: () => void): () => void;
}

export function createWorkspaceFilePreviewNodeController(input: {
  appI18n: I18nRuntime<string>;
  hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  initialFile: WorkspaceFileActivationTarget | null;
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
  private activeFileKey: string | null = null;
  private disposed = false;
  private loadGeneration = 0;
  private objectUrl: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly input: {
    appI18n: I18nRuntime<string>;
    hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
    i18n: WorkspaceWorkbenchDesktopI18nRuntime;
    initialFile: WorkspaceFileActivationTarget | null;
    tuttidClient: Pick<
      TuttidClient,
      "readWorkspaceFilePreview" | "writeWorkspaceFileText"
    >;
    onRuntimeStateChange(state: unknown): void;
    onSnapshotStateChange(state: unknown): void;
    workspaceID: string;
  };
  private runtimeStateKey: string | null = null;
  private snapshotStateKey: string | null = null;
  private state: WorkspaceFilePreviewNodeControllerState;

  constructor(input: {
    appI18n: I18nRuntime<string>;
    hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
    i18n: WorkspaceWorkbenchDesktopI18nRuntime;
    initialFile: WorkspaceFileActivationTarget | null;
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
    this.loadGeneration += 1;
    this.revokeObjectUrl();
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

  setActiveFile(file: WorkspaceFileActivationTarget | null): void {
    if (this.disposed) {
      return;
    }

    const nextKey = file ? workspaceFilePreviewNodeFileKey(file) : null;
    if (this.activeFileKey === nextKey) {
      return;
    }

    this.activeFileKey = nextKey;
    this.loadGeneration += 1;
    this.revokeObjectUrl();

    if (!file) {
      this.updateState(() => ({ status: "empty" }));
      return;
    }

    const generation = this.loadGeneration;
    this.updateState(() => ({ entry: file, status: "loading" }));
    void this.loadPreview(file, generation);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async loadPreview(
    target: WorkspaceFileActivationTarget,
    generation: number
  ): Promise<void> {
    try {
      const bytes = isAbsoluteFilesystemPath(target.path)
        ? normalizeWorkspaceFilePreviewBytes(
            await this.input.hostFilesApi.readLocalPreviewFile(target.path)
          )
        : normalizeWorkspaceFilePreviewBytes(
            decodeBase64Bytes(
              (
                await this.input.tuttidClient.readWorkspaceFilePreview(
                  this.input.workspaceID,
                  target.path
                )
              ).bytesBase64
            )
          );
      if (this.isStale(generation)) {
        return;
      }

      const loadedState = createWorkspaceFilePreviewLoadedState({
        bytes,
        entry: {
          ...target,
          kind: "file"
        },
        target
      });

      if (loadedState.status === "image" || loadedState.status === "video") {
        const objectUrl = URL.createObjectURL(
          new Blob([loadedState.bytes], {
            type: loadedState.contentType
          })
        );
        if (this.isStale(generation)) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        this.revokeObjectUrl();
        this.objectUrl = objectUrl;
        this.updateState(() => ({
          entry: target,
          objectUrl,
          status: loadedState.status
        }));
        return;
      }

      if (loadedState.status === "text") {
        this.updateState(() => ({
          content: loadedState.content,
          draft: loadedState.content,
          entry: target,
          saveStatus: "idle",
          status: "text"
        }));
        return;
      }

      if (loadedState.status === "html") {
        this.updateState(() => ({
          entry: target,
          message: this.input.appI18n.t(
            "workspaceFileManager.previewUnsupported"
          ),
          status: "unsupported"
        }));
        return;
      }

      this.updateState(() => ({
        entry: target,
        message: resolveReadonlyMessage(
          this.input.appI18n,
          loadedState.reason,
          loadedState.maxSizeBytes
        ),
        status: "readonly"
      }));
    } catch {
      if (this.isStale(generation)) {
        return;
      }
      this.updateState(() => ({
        entry: target,
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

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.loadGeneration;
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

  private revokeObjectUrl(): void {
    if (!this.objectUrl) {
      return;
    }
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
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
    textHeader:
      state.entry.fileKind === "text"
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
