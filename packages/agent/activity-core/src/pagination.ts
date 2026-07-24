import type { AgentActivitySessionMessageWindow } from "./messageWindow.types.ts";

export interface AgentActivityMessagePageLike<T> {
  messages: readonly T[];
  hasMore?: boolean;
  latestVersion?: number;
}

export interface LoadAllAgentSessionMessagesInput<T> {
  listPage: (afterVersion: number) => Promise<AgentActivityMessagePageLike<T>>;
  afterVersion?: number;
  maxPages?: number;
  shouldAbort?: () => boolean;
  onPage?: (messages: readonly T[]) => void;
}

export interface LoadAllAgentSessionMessagesResult<T> {
  messages: T[];
  aborted: boolean;
}

const DEFAULT_MAX_MESSAGE_PAGES = 1000;

/**
 * Projects the server-owned boundary of a newest-to-oldest page. The boundary
 * must come from `hasMore`; message versions are mutable change cursors and
 * cannot answer whether an older row exists.
 */
export function agentActivitySessionMessageWindowFromDescendingPage<
  T extends { version?: number | null }
>(page: AgentActivityMessagePageLike<T>): AgentActivitySessionMessageWindow {
  const oldestLoadedVersion = page.messages.reduce<number | null>(
    (oldest, message) => {
      const version = message.version;
      if (
        typeof version !== "number" ||
        !Number.isFinite(version) ||
        version <= 0
      ) {
        return oldest;
      }
      return oldest === null ? version : Math.min(oldest, version);
    },
    null
  );
  return {
    hasOlderMessages: oldestLoadedVersion !== null && page.hasMore === true,
    oldestLoadedVersion
  };
}

export async function loadAllAgentSessionMessages<
  T extends { version?: number }
>(
  input: LoadAllAgentSessionMessagesInput<T>
): Promise<LoadAllAgentSessionMessagesResult<T>> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_MESSAGE_PAGES;
  let afterVersion = input.afterVersion ?? 0;
  const messages: T[] = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await input.listPage(afterVersion);
    if (input.shouldAbort?.()) {
      return { messages, aborted: true };
    }
    if (page.messages.length > 0) {
      input.onPage?.(page.messages);
      messages.push(...page.messages);
    }
    const messageMaxVersion = page.messages.reduce(
      (maxVersion, message) => Math.max(maxVersion, message.version ?? 0),
      afterVersion
    );
    const pageLatestVersion =
      typeof page.latestVersion === "number" &&
      Number.isFinite(page.latestVersion)
        ? Math.max(0, Math.trunc(page.latestVersion))
        : afterVersion;
    const nextAfterVersion = Math.max(messageMaxVersion, pageLatestVersion);
    if (!page.hasMore || nextAfterVersion <= afterVersion) {
      break;
    }
    afterVersion = nextAfterVersion;
  }

  return { messages, aborted: false };
}
