/**
 * Shared preview loading lifecycle.
 *
 * Ownership rules: packages/workspace/file-preview/CONTRACT.md
 */

import {
  createWorkspaceFilePreviewLoadedState,
  resolveWorkspaceFileBuiltinRenderKind,
  resolveWorkspaceFilePreviewReadiness,
  type WorkspaceFilePreviewEntry,
  type WorkspaceFilePreviewKind,
  type WorkspaceFilePreviewReadonlyReason,
  type WorkspaceFilePreviewTarget
} from "./workspaceFilePreview.ts";

export type WorkspaceFilePreviewUnsupportedReason =
  | "file_type"
  | "reader_unavailable";

export type WorkspaceFilePreviewControllerState<TEntry> =
  | { status: "empty" }
  | { entry: TEntry; status: "directory" }
  | {
      entry: TEntry;
      previewKind: WorkspaceFilePreviewKind;
      status: "loading";
    }
  | {
      content: string;
      entry: TEntry;
      previewKind: WorkspaceFilePreviewKind;
      previewSizeBytes: number;
      status: "text";
    }
  | {
      entry: TEntry;
      objectUrl: string;
      previewKind: "image";
      previewSizeBytes: number;
      status: "image";
    }
  | {
      entry: TEntry;
      objectUrl: string;
      previewKind: "video";
      previewSizeBytes: number;
      status: "video";
    }
  | {
      bytes: Uint8Array<ArrayBuffer>;
      contentType: string | null;
      entry: TEntry;
      previewKind: WorkspaceFilePreviewKind;
      previewSizeBytes: number;
      status: "bytes";
    }
  | {
      entry: TEntry;
      maxSizeBytes?: number;
      previewKind?: WorkspaceFilePreviewKind;
      previewSizeBytes?: number;
      reason: WorkspaceFilePreviewReadonlyReason;
      status: "readonly";
    }
  | {
      entry: TEntry;
      previewKind?: WorkspaceFilePreviewKind;
      reason: WorkspaceFilePreviewUnsupportedReason;
      status: "unsupported";
    }
  | {
      entry: TEntry;
      error: unknown;
      previewKind?: WorkspaceFilePreviewKind;
      status: "error";
    };

export interface WorkspaceFilePreviewReadInput<TEntry> {
  entry: TEntry;
  signal: AbortSignal;
  target: WorkspaceFilePreviewTarget;
}

/**
 * Host read result. Bare Uint8Array / ArrayBuffer are intentionally not
 * accepted; wrap bytes in this object shape.
 */
export interface WorkspaceFilePreviewReadResult {
  bytes: Uint8Array | ArrayBuffer;
  contentType?: string | null;
  /** Optional host override of the classified preview kind. */
  kind?: WorkspaceFilePreviewKind;
}

export interface WorkspaceFilePreviewObjectUrlFactory {
  create(bytes: Uint8Array<ArrayBuffer>, contentType: string): string;
  revoke(objectUrl: string): void;
}

export interface CreateWorkspaceFilePreviewControllerInput<TEntry> {
  /**
   * Optional source capability gate. `false` blocks every non-directory read;
   * `true` also lets the reader classify locally unsupported files. When
   * omitted, the controller relies on local file classification.
   */
  canReadEntry?: (entry: TEntry) => boolean;
  getEntryKey?: (entry: TEntry) => string;
  /**
   * Host renderer registry probe used by readiness / load planning. Returning
   * true for a kind keeps hook-only kinds presentable and can prefer raw bytes
   * for text-degradable kinds that the host wants to render itself.
   */
  hasHostRenderer?: (kind: WorkspaceFilePreviewKind) => boolean;
  objectUrls?: WorkspaceFilePreviewObjectUrlFactory;
  read?: (
    input: WorkspaceFilePreviewReadInput<TEntry>
  ) => Promise<WorkspaceFilePreviewReadResult | null>;
  toPreviewEntry: (entry: TEntry) => WorkspaceFilePreviewEntry;
}

export interface WorkspaceFilePreviewController<TEntry> {
  dispose(): void;
  getSnapshot(): WorkspaceFilePreviewControllerState<TEntry>;
  reload(): Promise<void>;
  setEntry(entry: TEntry | null): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createWorkspaceFilePreviewController<TEntry>(
  input: CreateWorkspaceFilePreviewControllerInput<TEntry>
): WorkspaceFilePreviewController<TEntry> {
  return new WorkspaceFilePreviewControllerImpl(input);
}

class WorkspaceFilePreviewControllerImpl<
  TEntry
> implements WorkspaceFilePreviewController<TEntry> {
  private activeEntry: TEntry | null = null;
  private activeEntryKey: string | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  private generation = 0;
  private loadPromise: Promise<void> = Promise.resolve();
  private objectUrl: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly input: CreateWorkspaceFilePreviewControllerInput<TEntry>;
  private readonly objectUrls: WorkspaceFilePreviewObjectUrlFactory;
  private state: WorkspaceFilePreviewControllerState<TEntry> = {
    status: "empty"
  };

  constructor(input: CreateWorkspaceFilePreviewControllerInput<TEntry>) {
    this.input = input;
    this.objectUrls = input.objectUrls ?? browserWorkspaceFilePreviewObjectUrls;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelLoad();
    this.revokeObjectUrl();
    this.listeners.clear();
  }

  getSnapshot(): WorkspaceFilePreviewControllerState<TEntry> {
    return this.state;
  }

  reload(): Promise<void> {
    if (this.disposed || !this.activeEntry) {
      return Promise.resolve();
    }
    return this.start(this.activeEntry);
  }

  setEntry(entry: TEntry | null): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    const nextKey = entry ? this.resolveEntryKey(entry) : null;
    if (nextKey === this.activeEntryKey) {
      return this.loadPromise;
    }

    this.activeEntry = entry;
    this.activeEntryKey = nextKey;
    if (!entry) {
      this.cancelLoad();
      this.revokeObjectUrl();
      this.updateState({ status: "empty" });
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }
    return this.start(entry);
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private cancelLoad(): void {
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
  }

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private async load(
    entry: TEntry,
    previewEntry: WorkspaceFilePreviewEntry,
    target: WorkspaceFilePreviewTarget,
    generation: number,
    abortController: AbortController
  ): Promise<void> {
    try {
      const result = await this.input.read?.({
        entry,
        signal: abortController.signal,
        target
      });
      if (this.isStale(generation)) {
        return;
      }
      if (!result) {
        this.updateState({
          entry,
          previewKind: target.previewKind,
          reason: "file_type",
          status: "unsupported"
        });
        return;
      }

      const resolvedKind = result.kind ?? target.previewKind;
      const resolvedTarget: WorkspaceFilePreviewTarget = {
        ...target,
        previewKind: resolvedKind
      };
      // Hook-only kinds keep raw bytes for the host renderer. Text-degradable
      // kinds still decode to text; the surface may then prefer a host hook.
      const preferHostBytes =
        resolveWorkspaceFileBuiltinRenderKind(resolvedKind) === null;

      const loaded = createWorkspaceFilePreviewLoadedState({
        bytes: result.bytes,
        contentType: result.contentType,
        entry: previewEntry,
        preferHostBytes,
        target: resolvedTarget
      });
      if (this.isStale(generation)) {
        return;
      }

      if (loaded.status === "image") {
        const previewSizeBytes = loaded.bytes.byteLength;
        const objectUrl = this.objectUrls.create(
          loaded.bytes,
          loaded.contentType
        );
        if (this.isStale(generation)) {
          this.objectUrls.revoke(objectUrl);
          return;
        }
        this.objectUrl = objectUrl;
        this.updateState({
          entry,
          objectUrl,
          previewKind: "image",
          previewSizeBytes,
          status: "image"
        });
        return;
      }
      if (loaded.status === "video") {
        const previewSizeBytes = loaded.bytes.byteLength;
        const objectUrl = this.objectUrls.create(
          loaded.bytes,
          loaded.contentType
        );
        if (this.isStale(generation)) {
          this.objectUrls.revoke(objectUrl);
          return;
        }
        this.objectUrl = objectUrl;
        this.updateState({
          entry,
          objectUrl,
          previewKind: "video",
          previewSizeBytes,
          status: "video"
        });
        return;
      }
      if (loaded.status === "text") {
        this.updateState({
          content: loaded.content,
          entry,
          previewKind: loaded.previewKind,
          previewSizeBytes: result.bytes.byteLength,
          status: "text"
        });
        return;
      }
      if (loaded.status === "bytes") {
        this.updateState({
          bytes: loaded.bytes,
          contentType: loaded.contentType,
          entry,
          previewKind: loaded.previewKind,
          previewSizeBytes: loaded.bytes.byteLength,
          status: "bytes"
        });
        return;
      }
      this.updateState({
        entry,
        previewKind: target.previewKind,
        previewSizeBytes: result.bytes.byteLength,
        reason: loaded.reason,
        ...(loaded.maxSizeBytes === undefined
          ? {}
          : { maxSizeBytes: loaded.maxSizeBytes }),
        status: "readonly"
      });
    } catch (error) {
      if (this.isStale(generation)) {
        return;
      }
      this.updateState({
        entry,
        error,
        previewKind: target.previewKind,
        status: "error"
      });
    } finally {
      if (!this.isStale(generation)) {
        this.abortController = null;
      }
    }
  }

  private resolveEntryKey(entry: TEntry): string {
    if (this.input.getEntryKey) {
      return this.input.getEntryKey(entry);
    }
    const previewEntry = this.input.toPreviewEntry(entry);
    return [
      previewEntry.kind,
      previewEntry.path,
      previewEntry.name ?? "",
      previewEntry.sizeBytes ?? "",
      previewEntry.mtimeMs ?? ""
    ].join("\0");
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) {
      return;
    }
    this.objectUrls.revoke(this.objectUrl);
    this.objectUrl = null;
  }

  private start(entry: TEntry): Promise<void> {
    this.cancelLoad();
    this.revokeObjectUrl();

    const previewEntry = this.input.toPreviewEntry(entry);
    const readiness = resolveWorkspaceFilePreviewReadiness(previewEntry, {
      hasHostRenderer: this.input.hasHostRenderer
    });

    if (readiness.status === "directory") {
      this.updateState({ entry, status: "directory" });
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }

    const canRead = this.input.canReadEntry?.(entry);
    if (canRead === false) {
      this.updateState({
        entry,
        reason: "reader_unavailable",
        status: "unsupported"
      });
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }

    if (readiness.status === "unsupported") {
      if (canRead !== true) {
        this.updateState({
          entry,
          previewKind: readiness.previewKind,
          reason: "file_type",
          status: "unsupported"
        });
        this.loadPromise = Promise.resolve();
        return this.loadPromise;
      }
      if (!this.input.read) {
        this.updateState({
          entry,
          previewKind: readiness.previewKind,
          reason: "reader_unavailable",
          status: "unsupported"
        });
        this.loadPromise = Promise.resolve();
        return this.loadPromise;
      }
      // Source claimed it can classify/read locally unsupported files as text.
      const target: WorkspaceFilePreviewTarget = {
        previewKind: "text",
        name:
          previewEntry.name ??
          previewEntry.path.split("/").pop() ??
          previewEntry.path,
        path: previewEntry.path,
        ...(previewEntry.mtimeMs === undefined
          ? {}
          : { mtimeMs: previewEntry.mtimeMs }),
        ...(previewEntry.sizeBytes === undefined
          ? {}
          : { sizeBytes: previewEntry.sizeBytes })
      };
      return this.beginLoad(entry, previewEntry, target);
    }

    if (readiness.status === "readonly") {
      this.updateState({
        entry,
        maxSizeBytes: readiness.maxSizeBytes,
        reason: readiness.reason,
        status: "readonly"
      });
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }

    if (!this.input.read) {
      this.updateState({
        entry,
        previewKind: readiness.target.previewKind,
        reason: "reader_unavailable",
        status: "unsupported"
      });
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }

    return this.beginLoad(entry, previewEntry, readiness.target);
  }

  private beginLoad(
    entry: TEntry,
    previewEntry: WorkspaceFilePreviewEntry,
    target: WorkspaceFilePreviewTarget
  ): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    const generation = this.generation;
    this.updateState({
      entry,
      previewKind: target.previewKind,
      status: "loading"
    });
    this.loadPromise = this.load(
      entry,
      previewEntry,
      target,
      generation,
      abortController
    );
    return this.loadPromise;
  }

  private updateState(
    state: WorkspaceFilePreviewControllerState<TEntry>
  ): void {
    if (this.disposed) {
      return;
    }
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const browserWorkspaceFilePreviewObjectUrls: WorkspaceFilePreviewObjectUrlFactory =
  {
    create(bytes, contentType) {
      return URL.createObjectURL(new Blob([bytes], { type: contentType }));
    },
    revoke(objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  };
