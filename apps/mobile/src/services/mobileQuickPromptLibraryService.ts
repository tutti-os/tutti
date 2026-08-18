import type {
  AgentQuickPrompt,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { ObservableService } from "./observableService";

export interface MobileQuickPromptLibrarySnapshot {
  enabled: boolean;
  errorCode: "request_failed" | null;
  prompts: readonly AgentQuickPrompt[];
  status: "idle" | "loading" | "ready" | "error";
}

const initialSnapshot: MobileQuickPromptLibrarySnapshot = {
  enabled: true,
  errorCode: null,
  prompts: [],
  status: "idle"
};

export class MobileQuickPromptLibraryService extends ObservableService<MobileQuickPromptLibrarySnapshot> {
  readonly _serviceBrand: undefined;
  private snapshot = initialSnapshot;
  private refreshPromise: Promise<void> | null = null;
  private refreshGeneration = 0;
  private disposed = false;

  constructor(private readonly client: TuttidClient) {
    super();
  }

  getSnapshot = (): MobileQuickPromptLibrarySnapshot => this.snapshot;

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.disposed) return Promise.resolve();
    this.publish({
      ...this.snapshot,
      enabled: true,
      errorCode: null,
      status: "loading"
    });
    const generation = ++this.refreshGeneration;
    const refreshPromise = this.client
      .listAgentQuickPrompts()
      .then(({ prompts }) => {
        if (this.disposed || generation !== this.refreshGeneration) return;
        this.publish({
          enabled: true,
          errorCode: null,
          prompts,
          status: "ready"
        });
      })
      .catch(() => {
        if (this.disposed || generation !== this.refreshGeneration) return;
        this.publish({
          enabled: true,
          errorCode: "request_failed",
          prompts: this.snapshot.prompts,
          status: "error"
        });
      })
      .finally(() => {
        if (this.refreshPromise === refreshPromise) {
          this.refreshPromise = null;
        }
      });
    this.refreshPromise = refreshPromise;
    return refreshPromise;
  }

  reset(): void {
    if (this.disposed) return;
    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.publish(initialSnapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.snapshot = initialSnapshot;
    this.clearListeners();
  }

  private publish(snapshot: MobileQuickPromptLibrarySnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    this.emitChange();
  }
}
