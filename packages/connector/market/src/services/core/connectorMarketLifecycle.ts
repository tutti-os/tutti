export type ConnectorMarketLifecyclePhase =
  | "created"
  | "starting"
  | "synchronizing"
  | "materializing"
  | "ready"
  | "failed"
  | "stopping"
  | "disposed";

const allowedTransitions: Record<
  ConnectorMarketLifecyclePhase,
  readonly ConnectorMarketLifecyclePhase[]
> = {
  created: ["starting", "stopping"],
  starting: ["synchronizing", "failed", "stopping"],
  synchronizing: ["materializing", "failed", "stopping"],
  materializing: ["ready", "failed", "stopping"],
  ready: ["failed", "stopping"],
  failed: ["stopping"],
  stopping: ["disposed"],
  disposed: []
};

export class ConnectorMarketLifecycle {
  private currentPhase: ConnectorMarketLifecyclePhase = "created";
  private startupError: unknown = null;

  get phase(): ConnectorMarketLifecyclePhase {
    return this.currentPhase;
  }

  get error(): unknown {
    return this.startupError;
  }

  advance(next: ConnectorMarketLifecyclePhase): void {
    if (this.currentPhase === next) {
      return;
    }
    if (!allowedTransitions[this.currentPhase].includes(next)) {
      throw new Error(
        `Invalid connector-market lifecycle transition: ${this.currentPhase} -> ${next}`
      );
    }
    this.currentPhase = next;
  }

  fail(error: unknown): void {
    this.startupError = error;
    if (this.currentPhase !== "failed") {
      this.advance("failed");
    }
  }
}
