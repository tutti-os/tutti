import {
  createAgentActivityOptimisticMessageOverlay,
  type AgentActivityMessage,
  type AgentActivityMessageDeltaEvent,
  type AgentActivityOptimisticApplyResult,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";

/**
 * Owns the renderer-local projection of lossy message deltas over canonical
 * engine snapshots. Transport cleanup and reconcile scheduling stay in the
 * bridge; UI consumers only observe ordinary AgentActivitySnapshot values.
 */
export class WorkspaceAgentActivityOptimisticProjection {
  private readonly overlay = createAgentActivityOptimisticMessageOverlay();
  private readonly sessionIdsByWorkspaceId = new Map<string, Set<string>>();
  private readonly revisionByWorkspaceId = new Map<string, number>();
  private readonly snapshotCache = new Map<
    string,
    {
      canonical: AgentActivitySnapshot;
      projected: AgentActivitySnapshot;
      revision: number;
    }
  >();
  private readonly listenersByWorkspaceId = new Map<string, Set<() => void>>();

  project(
    workspaceId: string,
    canonical: AgentActivitySnapshot
  ): AgentActivitySnapshot {
    const revision = this.revisionByWorkspaceId.get(workspaceId) ?? 0;
    const cached = this.snapshotCache.get(workspaceId);
    if (cached?.canonical === canonical && cached.revision === revision) {
      return cached.projected;
    }
    const sessionIds = new Set([
      ...Object.keys(canonical.sessionMessagesById),
      ...(this.sessionIdsByWorkspaceId.get(workspaceId) ?? [])
    ]);
    const sessionMessagesById = { ...canonical.sessionMessagesById };
    for (const agentSessionId of sessionIds) {
      sessionMessagesById[agentSessionId] = this.overlay.project(
        { workspaceId, agentSessionId },
        canonical.sessionMessagesById[agentSessionId] ?? []
      );
    }
    const projected =
      sessionIds.size === 0 ? canonical : { ...canonical, sessionMessagesById };
    this.snapshotCache.set(workspaceId, { canonical, projected, revision });
    return projected;
  }

  apply(
    event: AgentActivityMessageDeltaEvent
  ): AgentActivityOptimisticApplyResult {
    const result = this.overlay.apply(event);
    if (!result.applied) return result;
    let sessionIds = this.sessionIdsByWorkspaceId.get(event.workspaceId);
    if (!sessionIds) {
      sessionIds = new Set();
      this.sessionIdsByWorkspaceId.set(event.workspaceId, sessionIds);
    }
    sessionIds.add(event.agentSessionId);
    this.markChanged(event.workspaceId);
    return result;
  }

  reconcile(
    workspaceId: string,
    agentSessionId: string,
    canonicalMessages: readonly AgentActivityMessage[]
  ): void {
    this.overlay.reconcile({ workspaceId, agentSessionId }, canonicalMessages);
    this.markChanged(workspaceId);
  }

  reset(workspaceId: string, agentSessionId: string): void {
    this.overlay.reset({ workspaceId, agentSessionId });
    this.sessionIdsByWorkspaceId.get(workspaceId)?.delete(agentSessionId);
    this.markChanged(workspaceId);
  }

  subscribe(workspaceId: string, listener: () => void): () => void {
    let listeners = this.listenersByWorkspaceId.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.listenersByWorkspaceId.set(workspaceId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.listenersByWorkspaceId.delete(workspaceId);
      }
    };
  }

  dispose(): void {
    this.sessionIdsByWorkspaceId.clear();
    this.revisionByWorkspaceId.clear();
    this.snapshotCache.clear();
    this.listenersByWorkspaceId.clear();
  }

  private markChanged(workspaceId: string): void {
    this.revisionByWorkspaceId.set(
      workspaceId,
      (this.revisionByWorkspaceId.get(workspaceId) ?? 0) + 1
    );
    this.snapshotCache.delete(workspaceId);
    for (const listener of this.listenersByWorkspaceId.get(workspaceId) ?? []) {
      listener();
    }
  }
}
