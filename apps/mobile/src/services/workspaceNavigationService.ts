import { ObservableService } from "./observableService";

export interface WorkspaceNavigationSnapshot {
  creating: boolean;
  selectedAgentSessionId: string | null;
  selectedAgentTargetId: string | null;
}

export class WorkspaceNavigationService extends ObservableService<WorkspaceNavigationSnapshot> {
  readonly _serviceBrand: undefined;
  private sessionSelectionExplicit = false;
  private snapshot: WorkspaceNavigationSnapshot = {
    creating: false,
    selectedAgentSessionId: null,
    selectedAgentTargetId: null
  };

  getSnapshot = (): WorkspaceNavigationSnapshot => this.snapshot;

  selectSession(agentSessionId: string | null): void {
    this.sessionSelectionExplicit = true;
    this.patch({
      creating: false,
      selectedAgentSessionId: agentSessionId
    });
  }

  startCreating(defaultTargetId: string | null): void {
    this.sessionSelectionExplicit = true;
    this.patch({
      creating: true,
      selectedAgentSessionId: null,
      selectedAgentTargetId: defaultTargetId
    });
  }

  selectTarget(agentTargetId: string): void {
    this.patch({ selectedAgentTargetId: agentTargetId });
  }

  reconcileSessionIds(sessionIds: readonly string[]): void {
    if (this.snapshot.creating || this.sessionSelectionExplicit) return;
    const current = this.snapshot.selectedAgentSessionId;
    if (current && sessionIds.includes(current)) return;
    this.patch({ selectedAgentSessionId: sessionIds[0] ?? null });
  }

  reconcileTargetIds(targetIds: readonly string[]): void {
    const current = this.snapshot.selectedAgentTargetId;
    if (current && targetIds.includes(current)) return;
    this.patch({
      selectedAgentTargetId: targetIds.length === 1 ? targetIds[0]! : null
    });
  }

  dispose(): void {
    this.clearListeners();
  }

  private patch(patch: Partial<WorkspaceNavigationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitChange();
  }
}
