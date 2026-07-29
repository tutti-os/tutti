import { resolveWorkspaceFileActivationTarget } from "../workspaceFileManagerModel.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerHost } from "../workspaceFileManagerHost.interface.ts";
import type {
  WorkspaceFileManagerFileActivationRequest,
  WorkspaceFileManagerHostFallbackAction,
  WorkspaceFileManagerHostFileActivationResult
} from "../workspaceFileManagerHostTypes.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerFileDefaultOpener,
  WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerActivationControllerInput {
  copy: () => WorkspaceFileManagerI18nRuntime;
  host: WorkspaceFileManagerHost;
  loadDirectory: (path: string) => Promise<void>;
  resolveErrorMessage: (
    error: unknown,
    overrides?: Record<string, string | undefined>
  ) => string;
  resolveFileDefaultOpener?: (
    entry: WorkspaceFileEntry
  ) => WorkspaceFileManagerFileDefaultOpener | null | undefined;
  store: WorkspaceFileManagerState;
}

export class WorkspaceFileManagerActivationController {
  private readonly copy: () => WorkspaceFileManagerI18nRuntime;
  private readonly host: WorkspaceFileManagerHost;
  private readonly loadDirectory: (path: string) => Promise<void>;
  private readonly resolveErrorMessage: (
    error: unknown,
    overrides?: Record<string, string | undefined>
  ) => string;
  private readonly resolveFileDefaultOpener?: (
    entry: WorkspaceFileEntry
  ) => WorkspaceFileManagerFileDefaultOpener | null | undefined;
  private readonly store: WorkspaceFileManagerState;

  constructor(input: WorkspaceFileManagerActivationControllerInput) {
    this.copy = input.copy;
    this.host = input.host;
    this.loadDirectory = input.loadDirectory;
    this.resolveErrorMessage = input.resolveErrorMessage;
    this.resolveFileDefaultOpener = input.resolveFileDefaultOpener;
    this.store = input.store;
  }

  async activateFile(
    request: WorkspaceFileManagerFileActivationRequest
  ): Promise<WorkspaceFileManagerHostFileActivationResult> {
    const copy = this.copy();
    if (!this.host.activateFile) {
      return {
        disposition: "unsupported",
        message: copy.t("unsupportedViewBody", { name: request.entry.name }),
        title: copy.t("unsupportedViewTitle")
      } as const;
    }

    try {
      const result = await this.host.activateFile(
        request,
        this.store.workspaceID
      );
      if (result.disposition !== "fallback" || !result.actions) {
        return result;
      }

      const fallbackActionKinds = new Set(
        result.actions.map((action) => action.kind)
      );
      return {
        ...result,
        actions: result.actions.map((action) =>
          this.wrapFallbackAction(action, copy)
        ),
        message:
          result.message ??
          (fallbackActionKinds.has("download")
            ? copy.t("previewUnavailableDownloadBody", {
                name: request.entry.name
              })
            : copy.t("previewUnavailableOpenBody", {
                name: request.entry.name
              })),
        title: result.title ?? copy.t("previewUnavailableTitle")
      };
    } catch (error) {
      return {
        actions: [
          {
            kind: "open",
            label: copy.t("retryLabel"),
            onSelect: async () => this.activateFile(request)
          }
        ],
        disposition: "unsupported",
        message: this.resolveErrorMessage(error),
        title: copy.t("openFailedTitle")
      } as const;
    }
  }

  async handleFallbackAction(
    action: WorkspaceFileManagerHostFallbackAction
  ): Promise<void> {
    if (action.kind === "none" || !action.onSelect) {
      return;
    }

    const entryPath = this.store.unsupportedDialog?.entryPath ?? null;
    const entry = entryPath ? this.findEntry(entryPath) : null;
    this.store.busyAction = "view";
    try {
      const result = await action.onSelect();
      if (!entry) {
        this.store.unsupportedDialog = null;
        return;
      }
      this.applyActivationResult(result, entry);
    } finally {
      this.store.busyAction = null;
    }
  }

  async openEntry(entry: WorkspaceFileEntry): Promise<void> {
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;

    if (entry.kind === "directory") {
      this.store.pendingDirectoryPath = entry.path;
      try {
        await this.loadDirectory(entry.path);
      } finally {
        if (this.store.pendingDirectoryPath === entry.path) {
          this.store.pendingDirectoryPath = null;
        }
      }
      return;
    }

    const opener = this.resolveFileDefaultOpener?.(entry) ?? null;
    if (opener && opener !== "fileViewer") {
      const handled = await this.openFileWithConfiguredOpener(entry, opener);
      if (handled) {
        return;
      }
    }

    await this.openFileInFileViewer(entry);
  }

  async openFileInFileViewer(entry: WorkspaceFileEntry): Promise<void> {
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    this.store.busyAction = "view";
    try {
      const result = await this.activateFile({
        entry,
        target: resolveWorkspaceFileActivationTarget(entry)
      });
      this.applyActivationResult(result, entry);
    } finally {
      this.store.busyAction = null;
    }
  }

  private async openFileWithConfiguredOpener(
    entry: WorkspaceFileEntry,
    opener: WorkspaceFileManagerFileDefaultOpener
  ): Promise<boolean> {
    switch (opener) {
      case "appBrowser":
        if (!this.host.openFileInAppBrowser) {
          return false;
        }
        await this.host.openFileInAppBrowser({
          path: entry.path,
          workspaceID: this.store.workspaceID
        });
        return true;
      case "defaultBrowser":
        if (!this.host.openFileInDefaultBrowser) {
          return false;
        }
        await this.host.openFileInDefaultBrowser({
          path: entry.path,
          workspaceID: this.store.workspaceID
        });
        return true;
      case "system":
        if (!this.host.openFileInSystemDefault) {
          return false;
        }
        await this.host.openFileInSystemDefault({
          path: entry.path,
          workspaceID: this.store.workspaceID
        });
        return true;
      case "fileViewer":
        return false;
    }
  }

  private applyActivationResult(
    result: WorkspaceFileManagerHostFileActivationResult | void,
    entry: WorkspaceFileEntry
  ): void {
    if (!result || result.disposition === "handled") {
      this.store.unsupportedDialog = null;
      return;
    }

    this.store.unsupportedDialog = {
      actions: result.actions ?? null,
      entryPath: entry.path,
      kind: "view",
      message: result.message,
      title: result.title
    };
  }

  private findEntry(entryPath: string): WorkspaceFileEntry | null {
    return this.store.entries.find((entry) => entry.path === entryPath) ?? null;
  }

  private wrapFallbackAction(
    action: WorkspaceFileManagerHostFallbackAction,
    copy: WorkspaceFileManagerI18nRuntime
  ): WorkspaceFileManagerHostFallbackAction {
    if (action.kind === "none" || !action.onSelect) {
      return action;
    }

    return {
      ...action,
      onSelect: async () => {
        try {
          return await action.onSelect();
        } catch (error) {
          return {
            actions: [
              this.wrapFallbackAction(
                {
                  ...action,
                  label: copy.t("retryLabel")
                },
                copy
              )
            ],
            disposition: "unsupported",
            message: this.resolveErrorMessage(error),
            title:
              action.kind === "download"
                ? copy.t("downloadFailedTitle")
                : copy.t("openFailedTitle")
          } as const;
        }
      }
    };
  }
}
