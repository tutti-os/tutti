import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { ConversationRailRefreshedPage } from "./agentGuiConversationRailQueryCache";

const SECTION_PAGE_SIZE = 5;

type TargetedPageRuntime = Pick<
  AgentActivityRuntime,
  "listPinnedSessionsPage" | "listSessionSectionPage"
>;

export class AgentGUIConversationRailTargetedPageRefresher {
  private abortController: AbortController | null = null;
  private readonly pendingPageIds = new Set<string>();
  private requestSequence = 0;

  constructor(
    private readonly input: {
      onFailed?(): void;
      onResolved(pages: readonly ConversationRailRefreshedPage[]): void;
      runtime: TargetedPageRuntime;
      workspaceId: string;
    }
  ) {}

  refresh(input: { agentTargetId: string; pageIds: readonly string[] }): void {
    for (const pageId of input.pageIds) this.pendingPageIds.add(pageId);
    if (this.pendingPageIds.size === 0) return;

    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    const requestSequence = ++this.requestSequence;
    const pageIds = [...this.pendingPageIds];
    const requests = pageIds.flatMap((id) => {
      if (id === "pinned") {
        const listPage = this.input.runtime.listPinnedSessionsPage;
        return listPage
          ? [
              listPage({
                agentTargetId: input.agentTargetId || undefined,
                limit: SECTION_PAGE_SIZE,
                signal: abortController.signal,
                workspaceId: this.input.workspaceId
              }).then(
                (page): ConversationRailRefreshedPage => ({
                  kind: "pinned",
                  page
                })
              )
            ]
          : [];
      }
      const listPage = this.input.runtime.listSessionSectionPage;
      return listPage
        ? [
            listPage({
              agentTargetId: input.agentTargetId || undefined,
              limit: SECTION_PAGE_SIZE,
              sectionKey: id,
              signal: abortController.signal,
              workspaceId: this.input.workspaceId
            }).then(
              (page): ConversationRailRefreshedPage => ({
                id,
                kind: "section",
                page
              })
            )
          ]
        : [];
    });
    if (requests.length !== pageIds.length) {
      for (const id of pageIds) this.pendingPageIds.delete(id);
      this.input.onFailed?.();
      return;
    }
    void Promise.all(requests)
      .then((pages) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.requestSequence
        ) {
          return;
        }
        for (const id of pageIds) this.pendingPageIds.delete(id);
        this.input.onResolved(pages);
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.requestSequence
        ) {
          return;
        }
        for (const id of pageIds) this.pendingPageIds.delete(id);
        this.input.onFailed?.();
      });
  }

  cancel(): void {
    this.requestSequence += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.pendingPageIds.clear();
  }
}
