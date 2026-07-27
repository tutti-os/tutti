export interface AgentMentionDirectoryRequest {
  requestId: number;
  abortSignal: AbortSignal;
}

export interface AgentMentionDirectoryRequestScope {
  activeDirectoryPath: string | undefined;
  activeWorkspaceId: string;
  directoryPath: string;
  disposed: boolean;
  filter: string;
  query: string;
  requestId: number;
  workspaceId: string;
}

export class AgentMentionDirectoryRequestLifecycle {
  private requestId = 0;
  private abortController: AbortController | null = null;

  start(): AgentMentionDirectoryRequest {
    this.abortActiveRequest();
    const abortController = new AbortController();
    const requestId = ++this.requestId;
    this.abortController = abortController;
    return {
      requestId,
      abortSignal: abortController.signal
    };
  }

  cancel(): void {
    this.abortActiveRequest();
    this.requestId += 1;
  }

  canApply(scope: AgentMentionDirectoryRequestScope): boolean {
    return (
      !scope.disposed &&
      scope.requestId === this.requestId &&
      this.abortController?.signal.aborted === false &&
      scope.workspaceId === scope.activeWorkspaceId &&
      scope.filter === "file" &&
      scope.query === "" &&
      scope.activeDirectoryPath === scope.directoryPath
    );
  }

  finish(requestId: number): void {
    if (requestId === this.requestId) {
      this.abortController = null;
    }
  }

  private abortActiveRequest(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
