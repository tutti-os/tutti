export interface WorkspaceAgentWaitingNotificationLeaseRegistry {
  isOwner(workspaceId: string, contender: object): boolean;
  register(
    workspaceId: string,
    contender: object,
    listener: () => void
  ): () => void;
}

export function createWorkspaceAgentWaitingNotificationLeaseRegistry(): WorkspaceAgentWaitingNotificationLeaseRegistry {
  const contendersByWorkspace = new Map<string, Map<object, () => void>>();
  return {
    isOwner(workspaceId, contender) {
      return (
        contendersByWorkspace.get(workspaceId)?.keys().next().value ===
        contender
      );
    },
    register(workspaceId, contender, listener) {
      const contenders =
        contendersByWorkspace.get(workspaceId) ?? new Map<object, () => void>();
      contenders.set(contender, listener);
      contendersByWorkspace.set(workspaceId, contenders);
      return () => {
        const current = contendersByWorkspace.get(workspaceId);
        if (!current) {
          return;
        }
        const wasOwner = current.keys().next().value === contender;
        current.delete(contender);
        if (current.size === 0) {
          contendersByWorkspace.delete(workspaceId);
        } else if (wasOwner) {
          for (const notify of current.values()) {
            notify();
          }
        }
      };
    }
  };
}

export const workspaceAgentWaitingNotificationLeaseRegistry =
  createWorkspaceAgentWaitingNotificationLeaseRegistry();
