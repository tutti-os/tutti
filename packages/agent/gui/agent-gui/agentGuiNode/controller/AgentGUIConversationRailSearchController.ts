import type { AgentActivitySession } from "@tutti-os/agent-activity-core";
import type {
  AgentGuiScheduledTask,
  AgentGuiScheduler
} from "../agentGuiScheduler";
import {
  appendConversationSearchPage,
  EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
  type ConversationSearchQueryState
} from "./agentConversationRailQuerySnapshot";
import type { ConversationRailQueryRuntime } from "./agentGuiConversationRailQueryTypes";

export const CONVERSATION_SEARCH_DEBOUNCE_MS = 300;

type ListSessionsPage = NonNullable<
  ConversationRailQueryRuntime["listSessionsPage"]
>;

export class AgentGUIConversationRailSearchController {
  private agentTargetId = "";
  private abortController: AbortController | null = null;
  private debounceTask: AgentGuiScheduledTask | null = null;
  private publicationState: "idle" | "pending" | "failed" = "idle";
  private query = "";
  private requestKey: string | null = null;
  private requestSequence = 0;
  private state = EMPTY_CONVERSATION_SEARCH_QUERY_STATE;

  constructor(
    private readonly input: {
      isSectionPublicationBlocked(): boolean;
      listSessionsPage?: ListSessionsPage;
      onChanged(): void;
      scheduler: AgentGuiScheduler;
      upsertSessions(sessions: readonly AgentActivitySession[]): void;
      workspaceId: string;
    }
  ) {}

  get queryState(): ConversationSearchQueryState {
    return this.state;
  }

  get searchQuery(): string {
    return this.query;
  }

  get searchRequestKey(): string | null {
    return this.requestKey;
  }

  get enabled(): boolean {
    return Boolean(this.input.listSessionsPage);
  }

  get publicationBlocked(): boolean {
    return this.publicationState !== "idle";
  }

  configureAgentTarget(agentTargetId: string): void {
    this.agentTargetId = agentTargetId;
    if (this.query) this.request();
  }

  setQuery(value: string): void {
    const query = value.trim();
    if (query === this.query) return;
    this.query = query;
    this.schedule();
  }

  request(membershipRefresh = false): void {
    this.clearDebounce();
    this.requestKey =
      this.enabled && this.query
        ? JSON.stringify([
            this.input.workspaceId,
            this.agentTargetId,
            this.query
          ])
        : null;
    this.requestSequence += 1;
    const requestSequence = this.requestSequence;
    this.abortController?.abort();
    this.abortController = null;
    const listSessionsPage = this.input.listSessionsPage;
    if (!listSessionsPage) {
      this.publicationState = "idle";
      this.state = EMPTY_CONVERSATION_SEARCH_QUERY_STATE;
      return;
    }
    if (!this.requestKey) {
      this.publicationState = "idle";
      this.state = EMPTY_CONVERSATION_SEARCH_QUERY_STATE;
      this.input.onChanged();
      return;
    }
    const requestKey = this.requestKey;
    const query = this.query;
    const tracksPublication =
      membershipRefresh ||
      this.publicationBlocked ||
      this.input.isSectionPublicationBlocked();
    const abortController = new AbortController();
    this.abortController = abortController;
    if (tracksPublication) this.publicationState = "pending";
    this.state = {
      ...EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
      pending: true,
      requestKey
    };
    this.input.onChanged();
    void listSessionsPage({
      agentTargetId: this.agentTargetId || undefined,
      limit: 100,
      searchQuery: query,
      signal: abortController.signal,
      workspaceId: this.input.workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.requestSequence ||
          requestKey !== this.requestKey
        ) {
          return;
        }
        this.input.upsertSessions(page.sessions);
        this.state = {
          failed: false,
          hasMore: page.hasMore,
          loadingMore: false,
          nextCursor: page.nextCursor ?? null,
          pending: false,
          requestKey,
          resolvedQuery: query,
          sessionIds: page.sessions.map((session) => session.agentSessionId)
        };
        if (tracksPublication) this.publicationState = "idle";
        this.input.onChanged();
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.requestSequence ||
          requestKey !== this.requestKey
        ) {
          return;
        }
        this.state = {
          ...EMPTY_CONVERSATION_SEARCH_QUERY_STATE,
          failed: true,
          requestKey,
          resolvedQuery: query
        };
        if (tracksPublication) this.publicationState = "failed";
        this.input.onChanged();
      });
  }

  loadMore(): void {
    const listSessionsPage = this.input.listSessionsPage;
    if (
      !this.enabled ||
      !listSessionsPage ||
      this.publicationBlocked ||
      this.input.isSectionPublicationBlocked() ||
      this.state.pending ||
      this.state.loadingMore ||
      !this.state.hasMore ||
      !this.state.nextCursor ||
      this.state.requestKey !== this.requestKey ||
      this.state.resolvedQuery !== this.query
    ) {
      return;
    }
    const requestSequence = this.requestSequence;
    const abortController = new AbortController();
    this.abortController?.abort();
    this.abortController = abortController;
    this.state = { ...this.state, loadingMore: true };
    this.input.onChanged();
    void listSessionsPage({
      agentTargetId: this.agentTargetId || undefined,
      cursor: this.state.nextCursor ?? undefined,
      limit: 100,
      searchQuery: this.query,
      signal: abortController.signal,
      workspaceId: this.input.workspaceId
    })
      .then((page) => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.requestSequence
        ) {
          return;
        }
        this.input.upsertSessions(page.sessions);
        this.state = appendConversationSearchPage(this.state, page);
        this.input.onChanged();
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          requestSequence !== this.requestSequence
        ) {
          return;
        }
        this.state = { ...this.state, failed: true, loadingMore: false };
        this.input.onChanged();
      });
  }

  retry(): void {
    if (!this.query || !this.enabled) return;
    this.request();
  }

  resetPublication(): void {
    this.publicationState = "idle";
  }

  detach(): void {
    if (this.publicationState === "pending") {
      this.publicationState = "failed";
    }
    this.clearDebounce();
    this.requestSequence += 1;
    this.abortController?.abort();
    this.abortController = null;
  }

  private schedule(): void {
    this.clearDebounce();
    this.requestSequence += 1;
    this.abortController?.abort();
    this.abortController = null;
    if (!this.query || !this.enabled) {
      this.request();
      return;
    }
    this.requestKey = null;
    this.input.onChanged();
    this.debounceTask = this.input.scheduler.schedule(
      CONVERSATION_SEARCH_DEBOUNCE_MS,
      () => {
        this.debounceTask = null;
        this.request();
      }
    );
  }

  private clearDebounce(): void {
    this.debounceTask?.cancel();
    this.debounceTask = null;
  }
}
