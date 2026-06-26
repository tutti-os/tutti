// Single source of truth for walking a session's message history.
//
// `listSessionMessages` returns at most one capped page (the daemon defaults to
// 100 messages) and reports `hasMore`. Every consumer that wants the *complete*
// transcript — the durable snapshot sync, the conversation detail view, the
// batch runner — must follow the version cursor until the server is exhausted.
// Doing that in one place keeps the cursor/termination logic consistent and
// testable instead of re-derived (and silently truncated) at each call site.

/** Minimal shape of a `listSessionMessages` response this loader relies on. */
export interface AgentActivityMessagePageLike<T> {
  messages: readonly T[];
  hasMore?: boolean;
}

export interface LoadAllAgentSessionMessagesInput<T> {
  /** Fetch a single page starting strictly after `afterVersion` (ascending). */
  listPage: (afterVersion: number) => Promise<AgentActivityMessagePageLike<T>>;
  /** Cursor to resume from; defaults to 0 (the oldest message). */
  afterVersion?: number;
  /**
   * Hard upper bound on page fetches. Only a termination guard for a
   * misbehaving server that reports `hasMore` without advancing the cursor; at
   * ~100 messages/page the default covers transcripts far larger than any real
   * session.
   */
  maxPages?: number;
  /**
   * Consulted after each page resolves. Returning `true` stops the walk and
   * marks the result `aborted` (e.g. the user navigated away mid-load). The
   * aborting page is not delivered to `onPage` or collected.
   */
  shouldAbort?: () => boolean;
  /** Invoked with each accepted page, for incremental merge into a cache. */
  onPage?: (messages: readonly T[]) => void;
}

export interface LoadAllAgentSessionMessagesResult<T> {
  messages: T[];
  aborted: boolean;
}

const DEFAULT_MAX_MESSAGE_PAGES = 1000;

export async function loadAllAgentSessionMessages<
  T extends { version?: number }
>(
  input: LoadAllAgentSessionMessagesInput<T>
): Promise<LoadAllAgentSessionMessagesResult<T>> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_MESSAGE_PAGES;
  let afterVersion = input.afterVersion ?? 0;
  const collected: T[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const response = await input.listPage(afterVersion);
    if (input.shouldAbort?.()) {
      return { messages: collected, aborted: true };
    }
    if (response.messages.length > 0) {
      input.onPage?.(response.messages);
      collected.push(...response.messages);
    }
    const nextAfterVersion = response.messages.reduce(
      (maxVersion, message) => Math.max(maxVersion, message.version ?? 0),
      afterVersion
    );
    if (!response.hasMore || nextAfterVersion <= afterVersion) {
      break;
    }
    afterVersion = nextAfterVersion;
  }

  return { messages: collected, aborted: false };
}
