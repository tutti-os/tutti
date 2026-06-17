import type { AgentComposerGitBranches } from "./AgentComposer";

export type AgentReviewBranchLoader = () => Promise<AgentComposerGitBranches>;

export interface AgentReviewBranchState {
  status: "idle" | "loading" | "ready" | "error";
  branches: readonly string[];
  currentBranch: string | null;
  error: string | null;
}

type Listener = (state: AgentReviewBranchState) => void;

const IDLE_STATE: AgentReviewBranchState = {
  status: "idle",
  branches: [],
  currentBranch: null,
  error: null
};

/**
 * Owns the git-branch loading for the review picker: lazy load, in-flight
 * de-duplication, caching, and loading/error state. The view subscribes to the
 * emitted state and calls commands; it must not orchestrate the async flow
 * itself. The `requestId` guard (not React effect cleanup) is what discards
 * stale results, so a loading-state update can never cancel its own request.
 */
export class AgentReviewBranchController {
  private readonly listeners = new Set<Listener>();
  private loader: AgentReviewBranchLoader | null;
  private requestId = 0;
  private disposed = false;
  private state: AgentReviewBranchState = IDLE_STATE;

  constructor(loader: AgentReviewBranchLoader | null = null) {
    this.loader = loader;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AgentReviewBranchState {
    return this.state;
  }

  /**
   * Point the controller at a new loader (i.e. a different working directory or
   * agent session). A changed loader invalidates any cached branches and any
   * in-flight request so the next `ensureLoaded` refetches.
   */
  setLoader(loader: AgentReviewBranchLoader | null): void {
    if (this.disposed || loader === this.loader) {
      return;
    }
    this.loader = loader;
    this.requestId += 1;
    this.setState(IDLE_STATE);
  }

  /**
   * Load branches once. No-op while a load is in flight or already resolved,
   * which provides both de-duplication and caching. Re-runs after an error to
   * allow retries.
   */
  ensureLoaded(): void {
    if (
      this.disposed ||
      !this.loader ||
      this.state.status === "loading" ||
      this.state.status === "ready"
    ) {
      return;
    }
    const loader = this.loader;
    const requestId = ++this.requestId;
    this.setState({
      status: "loading",
      branches: [],
      currentBranch: null,
      error: null
    });
    void loader()
      .then((result) => {
        if (this.disposed || requestId !== this.requestId) {
          return;
        }
        this.setState({
          status: "ready",
          branches: result.branches,
          currentBranch: result.currentBranch ?? null,
          error: null
        });
      })
      .catch((error: unknown) => {
        if (this.disposed || requestId !== this.requestId) {
          return;
        }
        this.setState({
          status: "error",
          branches: [],
          currentBranch: null,
          error:
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : String(error)
        });
      });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.requestId += 1;
  }

  private setState(state: AgentReviewBranchState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
