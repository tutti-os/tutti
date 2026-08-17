import type { AgentConversationRailRuntimePort } from "../../../agentConversationRailContracts";
import type { AgentGuiScheduler } from "../agentGuiScheduler";
import type { ConversationRailRefreshedPage } from "./agentGuiConversationRailQueryCache";
import {
  conversationRailRetryMode,
  isConversationRailAbortError,
  requestConversationRailWithRetry,
  type ConversationRailRetryMode
} from "./agentGuiConversationRailRequestRetry";

type TargetedPageRuntime = Pick<
  AgentConversationRailRuntimePort,
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
      onRetryScheduled?(mode: ConversationRailRetryMode): void;
      pageSize: number;
      runtime: TargetedPageRuntime;
      scheduler: AgentGuiScheduler;
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
    const createRequests = (
      signal: AbortSignal
    ): Promise<ConversationRailRefreshedPage>[] =>
      pageIds.flatMap((id) => {
        if (id === "pinned") {
          const listPage = this.input.runtime.listPinnedSessionsPage;
          return listPage
            ? [
                listPage({
                  agentTargetId: input.agentTargetId || undefined,
                  limit: this.input.pageSize,
                  signal,
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
                limit: this.input.pageSize,
                sectionKey: id,
                signal,
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
    const hasAllPageReaders = pageIds.every((id) =>
      id === "pinned"
        ? Boolean(this.input.runtime.listPinnedSessionsPage)
        : Boolean(this.input.runtime.listSessionSectionPage)
    );
    if (!hasAllPageReaders) {
      for (const id of pageIds) this.pendingPageIds.delete(id);
      this.input.onFailed?.();
      return;
    }
    void requestConversationRailWithRetry({
      onRetryScheduled: ({ mode }) => this.input.onRetryScheduled?.(mode),
      request: () =>
        requestTargetedPages({
          createRequests,
          signal: abortController.signal
        }),
      retryKey: JSON.stringify([
        this.input.workspaceId,
        input.agentTargetId,
        pageIds
      ]),
      scheduler: this.input.scheduler,
      signal: abortController.signal
    })
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

async function requestTargetedPages(input: {
  createRequests(signal: AbortSignal): Promise<ConversationRailRefreshedPage>[];
  signal: AbortSignal;
}): Promise<ConversationRailRefreshedPage[]> {
  const attemptAbortController = new AbortController();
  const abortFromParent = (): void => {
    attemptAbortController.abort(input.signal.reason);
  };
  input.signal.addEventListener("abort", abortFromParent, { once: true });
  if (input.signal.aborted) abortFromParent();
  const failures: unknown[] = [];
  try {
    const requests = input
      .createRequests(attemptAbortController.signal)
      .map((request) =>
        request.catch((error: unknown) => {
          failures.push(error);
          attemptAbortController.abort(error);
          throw error;
        })
      );
    try {
      return await Promise.all(requests);
    } catch (error) {
      attemptAbortController.abort(error);
      await Promise.resolve();
      throw preferredTargetedPageFailure(failures, error);
    }
  } finally {
    input.signal.removeEventListener("abort", abortFromParent);
  }
}

function preferredTargetedPageFailure(
  failures: readonly unknown[],
  fallback: unknown
): unknown {
  const eligible = failures.filter(
    (error) => !isConversationRailAbortError(error)
  );
  return (
    eligible.find((error) => conversationRailRetryMode(error) === null) ??
    eligible.find(
      (error) => conversationRailRetryMode(error) === "background"
    ) ??
    eligible[0] ??
    fallback
  );
}
