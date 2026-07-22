import {
  createWorkspaceFilePreviewController,
  formatWorkspacePreviewByteLimit,
  workspaceFilePreviewMaxBytes,
  type WorkspaceFilePreviewController,
  type WorkspaceFilePreviewControllerState,
  type WorkspaceFilePreviewReadonlyReason
} from "@tutti-os/workspace-file-preview";
import { resolveWorkspaceFileActivationTarget } from "../workspaceFileManagerModel.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerHost } from "../workspaceFileManagerHost.interface.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";
import { findWorkspaceFileEntry } from "./model/entryLookup.ts";

export interface WorkspaceFileManagerPreviewControllerInput {
  copy: () => WorkspaceFileManagerI18nRuntime;
  host: WorkspaceFileManagerHost;
  resolveErrorMessage: (
    error: unknown,
    overrides?: Record<string, string | undefined>
  ) => string;
  store: WorkspaceFileManagerState;
}

export class WorkspaceFileManagerPreviewController {
  private readonly copy: () => WorkspaceFileManagerI18nRuntime;
  private readonly resolveErrorMessage: (
    error: unknown,
    overrides?: Record<string, string | undefined>
  ) => string;
  private readonly store: WorkspaceFileManagerState;
  private readonly previewController: WorkspaceFilePreviewController<WorkspaceFileEntry>;
  private readonly unsubscribePreview: () => void;

  constructor(input: WorkspaceFileManagerPreviewControllerInput) {
    this.copy = input.copy;
    this.resolveErrorMessage = input.resolveErrorMessage;
    this.store = input.store;
    this.previewController = createWorkspaceFilePreviewController({
      read: input.host.readPreviewFile
        ? ({ entry }) =>
            input.host.readPreviewFile!(input.store.workspaceID, entry.path)
        : undefined,
      toPreviewEntry: (entry: WorkspaceFileEntry) => entry
    });
    this.unsubscribePreview = this.previewController.subscribe(() => {
      this.applyPreviewState(this.previewController.getSnapshot());
    });
  }

  dispose(): void {
    this.unsubscribePreview();
    this.previewController.dispose();
  }

  async syncPreviewState(): Promise<void> {
    const selectedEntry = findWorkspaceFileEntry(
      this.store,
      this.store.selectedPath
    );
    const settled = this.previewController.setEntry(selectedEntry);
    await settled;
    this.applyPreviewState(this.previewController.getSnapshot());
  }

  private applyPreviewState(
    state: WorkspaceFilePreviewControllerState<WorkspaceFileEntry>
  ): void {
    const copy = this.copy();
    switch (state.status) {
      case "empty":
        this.store.previewState = state;
        return;
      case "directory":
        this.store.previewState = state;
        return;
      case "loading":
      case "text":
      case "image":
      case "video": {
        const target = resolveWorkspaceFileActivationTarget(state.entry);
        if (!target) {
          this.store.previewState = {
            entry: state.entry,
            message: copy.t("previewUnsupported"),
            status: "unsupported"
          };
          return;
        }
        this.store.previewState =
          state.status === "loading"
            ? { entry: target, status: "loading" }
            : state.status === "text"
              ? { content: state.content, entry: target, status: "text" }
              : {
                  entry: target,
                  objectUrl: state.objectUrl,
                  status: state.status
                };
        return;
      }
      case "readonly":
        this.store.previewState = {
          entry: state.entry,
          message: resolveWorkspaceFileManagerPreviewReadonlyMessage(
            copy,
            state.reason,
            state.maxSizeBytes
          ),
          status: "readonly"
        };
        return;
      case "unsupported":
        this.store.previewState = {
          entry: state.entry,
          message: copy.t("previewUnsupported"),
          status: "unsupported"
        };
        return;
      case "error":
        this.store.previewState = {
          entry: state.entry,
          message: this.resolveErrorMessage(state.error, {
            preview_file_too_large: copy.t("previewFileTooLarge", {
              maxSize: formatWorkspacePreviewByteLimit(
                workspaceFilePreviewMaxBytes
              )
            })
          }),
          status: "error"
        };
    }
  }
}

function resolveWorkspaceFileManagerPreviewReadonlyMessage(
  copy: WorkspaceFileManagerI18nRuntime,
  reason: WorkspaceFilePreviewReadonlyReason,
  maxSizeBytes?: number
): string {
  switch (reason) {
    case "binary":
      return copy.t("previewBinary");
    case "decode_failed":
      return copy.t("previewDecodeFailed");
    case "file_too_large":
      return copy.t("previewFileTooLarge", {
        maxSize: formatWorkspacePreviewByteLimit(maxSizeBytes ?? 0)
      });
    case "text_too_large":
      return copy.t("previewTooLarge", {
        maxSize: formatWorkspacePreviewByteLimit(maxSizeBytes ?? 0)
      });
  }
}
