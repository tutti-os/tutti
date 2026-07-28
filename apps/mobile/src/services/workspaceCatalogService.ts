import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { ObservableService } from "./observableService";

export interface WorkspaceCatalogSnapshot {
  errorCode: "request_failed" | null;
  status: "idle" | "loading" | "ready";
  workspaces: readonly WorkspaceSummary[];
}

export class WorkspaceCatalogService extends ObservableService<WorkspaceCatalogSnapshot> {
  readonly _serviceBrand: undefined;
  private disposed = false;
  private loadPromise: Promise<void> | null = null;
  private snapshot: WorkspaceCatalogSnapshot = {
    errorCode: null,
    status: "idle",
    workspaces: []
  };

  constructor(private readonly client: TuttidClient) {
    super();
  }

  getSnapshot = (): WorkspaceCatalogSnapshot => this.snapshot;

  start(): Promise<void> {
    return this.load();
  }

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.snapshot = { ...this.snapshot, errorCode: null, status: "loading" };
    this.emitChange();
    this.loadPromise = this.client
      .listWorkspaces()
      .then((response) => {
        if (this.disposed) return;
        this.snapshot = {
          errorCode: null,
          status: "ready",
          workspaces: response.workspaces
        };
        this.emitChange();
      })
      .catch(() => {
        if (this.disposed) return;
        this.snapshot = {
          ...this.snapshot,
          errorCode: "request_failed",
          status: "ready"
        };
        this.emitChange();
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  dispose(): void {
    this.disposed = true;
    this.loadPromise = null;
    this.clearListeners();
  }
}
