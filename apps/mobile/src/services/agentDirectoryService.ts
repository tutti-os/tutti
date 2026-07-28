import type { AgentTarget, TuttidClient } from "@tutti-os/client-tuttid-ts";
import { ObservableService } from "./observableService";

export interface AgentDirectorySnapshot {
  errorCode: "request_failed" | null;
  status: "idle" | "loading" | "ready";
  targets: readonly AgentTarget[];
}

export class AgentDirectoryService extends ObservableService<AgentDirectorySnapshot> {
  readonly _serviceBrand: undefined;
  private loadPromise: Promise<void> | null = null;
  private disposed = false;
  private snapshot: AgentDirectorySnapshot = {
    errorCode: null,
    status: "idle",
    targets: []
  };

  constructor(private readonly client: TuttidClient) {
    super();
  }

  getSnapshot = (): AgentDirectorySnapshot => this.snapshot;

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.snapshot = { ...this.snapshot, errorCode: null, status: "loading" };
    this.emitChange();
    this.loadPromise = this.client
      .listAgentTargets()
      .then((catalog) => {
        if (this.disposed) return;
        this.snapshot = {
          errorCode: null,
          status: "ready",
          targets: catalog.targets.filter(
            (target) =>
              target.enabled &&
              (!target.availability || target.availability.status === "ready")
          )
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
