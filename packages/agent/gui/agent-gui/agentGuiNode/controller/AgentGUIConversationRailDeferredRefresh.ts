export interface ConversationRailDeferredRefreshPlan {
  pageIds: readonly string[];
  refreshSearch: boolean;
}

export class AgentGUIConversationRailDeferredRefresh {
  private readonly pageIds = new Set<string>();
  private refreshSearch = false;

  constructor(
    private readonly flush: (plan: ConversationRailDeferredRefreshPlan) => void
  ) {}

  clear(): void {
    this.pageIds.clear();
    this.refreshSearch = false;
  }

  deferIfPending(
    pending: boolean,
    plan: ConversationRailDeferredRefreshPlan
  ): boolean {
    if (!pending) return false;
    for (const pageId of plan.pageIds) this.pageIds.add(pageId);
    this.refreshSearch ||= plan.refreshSearch;
    return true;
  }

  flushIfReady(ready: boolean): void {
    if (!ready) return;
    const plan = {
      pageIds: [...this.pageIds],
      refreshSearch: this.refreshSearch
    };
    this.clear();
    if (plan.pageIds.length > 0 || plan.refreshSearch) this.flush(plan);
  }
}
