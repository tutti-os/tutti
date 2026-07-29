import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RichTextTriggerGroupPageQueryInput,
  RichTextTriggerGroupedQueryResult,
  RichTextTriggerQueryInput
} from "@tutti-os/ui-rich-text/types";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "./agentContextMentionProvider";
import {
  AgentMentionSearchController,
  resetAgentMentionSearchBrowseCacheForTests,
  type AgentMentionSearchState
} from "./AgentMentionSearchController";
import { flattenAgentMentionPaletteEntries } from "./AgentFileMentionPalette";
import { mentionGroupExpandCount } from "./agentMentionSearchHelpers";

interface TestIssue {
  issueId: string;
  status: string;
  title: string;
  topicId: string;
  workspaceId: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function issue(issueId: string, topicId: string): TestIssue {
  return {
    issueId,
    status: "open",
    title: issueId,
    topicId,
    workspaceId: "workspace-1"
  };
}

function groupedIssueProvider(input: {
  queryGroups: NonNullable<
    AgentContextMentionProvider<TestIssue>["queryGroups"]
  >;
  queryGroupPage?: NonNullable<
    AgentContextMentionProvider<TestIssue>["queryGroupPage"]
  >;
}): AgentContextMentionProvider<TestIssue> {
  return {
    id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceIssue,
    trigger: "@",
    query: async () => [],
    queryGroups: input.queryGroups,
    ...(input.queryGroupPage ? { queryGroupPage: input.queryGroupPage } : {}),
    getItemKey: (item) => item.issueId,
    getItemLabel: (item) => item.title,
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.issueId,
        label: item.title,
        scope: {
          topicId: item.topicId,
          workspaceId: item.workspaceId
        },
        presentation: { status: item.status }
      }
    })
  };
}

function groupedResult(
  groups: RichTextTriggerGroupedQueryResult<TestIssue>["groups"]
): RichTextTriggerGroupedQueryResult<TestIssue> {
  return { groups };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

describe("AgentMentionSearchController issue topic groups", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAgentMentionSearchBrowseCacheForTests();
  });

  it("atomically replaces search groups, encodes dynamic ids, and rejects an aborted stale search", async () => {
    vi.useFakeTimers();
    const first = deferred<RichTextTriggerGroupedQueryResult<TestIssue>>();
    const second = deferred<RichTextTriggerGroupedQueryResult<TestIssue>>();
    const signals: AbortSignal[] = [];
    const queryGroups = vi.fn(
      ({ abortSignal, keyword }: RichTextTriggerQueryInput) => {
        signals.push(abortSignal!);
        return keyword === "first" ? first.promise : second.promise;
      }
    );
    const controller = new AgentMentionSearchController({
      contextMentionProviders: [groupedIssueProvider({ queryGroups })]
    });
    const states: AgentMentionSearchState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setFilter("issue");

    controller.updateQuery({ workspaceId: "workspace-1", query: "first" });
    await vi.advanceTimersByTimeAsync(120);
    expect(queryGroups).toHaveBeenCalledTimes(1);

    controller.updateQuery({ workspaceId: "workspace-1", query: "second" });
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(queryGroups).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.status).toBe("loading");
    expect(
      states.at(-1)?.groups.some((group) => group.id.startsWith("issue-topic:"))
    ).toBe(false);

    first.resolve(
      groupedResult([
        {
          id: "stale/topic",
          label: "Stale",
          items: [issue("stale-1", "stale/topic")],
          totalCount: 1
        }
      ])
    );
    second.resolve(
      groupedResult([
        {
          id: "topic/one",
          label: "Pinned",
          items: [issue("issue-1", "topic/one")],
          totalCount: 11,
          nextCursor: "cursor-1"
        },
        {
          id: "topic:two",
          label: "Recent",
          items: [issue("issue-2", "topic:two")],
          totalCount: 1
        }
      ])
    );

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: "second",
        groups: [
          {
            id: "issue-topic:topic%2Fone",
            label: "Pinned",
            totalCount: 11,
            hasMore: true,
            items: [expect.objectContaining({ targetId: "issue-1" })]
          },
          {
            id: "issue-topic:topic%3Atwo",
            label: "Recent",
            totalCount: 1,
            hasMore: false,
            items: [expect.objectContaining({ targetId: "issue-2" })]
          }
        ]
      })
    );
    expect(states.at(-1)?.groups.some((group) => group.label === "Stale")).toBe(
      false
    );
  });

  it("keeps rows ready during load more, dedupes clicks and items, retries failures, and restores the browse cache before revalidation", async () => {
    const failedPage = deferred<{
      id: string;
      label: string;
      items: TestIssue[];
      totalCount: number;
      nextCursor?: string;
    }>();
    const retryPage = deferred<{
      id: string;
      label: string;
      items: TestIssue[];
      totalCount: number;
      nextCursor?: string;
    }>();
    const refresh = deferred<RichTextTriggerGroupedQueryResult<TestIssue>>();
    const queryGroups = vi
      .fn()
      .mockResolvedValueOnce(
        groupedResult([
          {
            id: "topic/one",
            label: "Pinned",
            items: [issue("issue-1", "topic/one")],
            totalCount: 2,
            nextCursor: "cursor-1"
          },
          {
            id: "topic:two",
            label: "Recent",
            items: [issue("issue-3", "topic:two")],
            totalCount: 1
          }
        ])
      )
      .mockReturnValueOnce(refresh.promise);
    const pageSignals: AbortSignal[] = [];
    let pageCallCount = 0;
    const queryGroupPage = vi.fn(
      (input: RichTextTriggerGroupPageQueryInput) => {
        pageSignals.push(input.abortSignal!);
        pageCallCount += 1;
        return pageCallCount === 1 ? failedPage.promise : retryPage.promise;
      }
    );
    const provider = groupedIssueProvider({ queryGroups, queryGroupPage });
    const controller = new AgentMentionSearchController({
      contextMentionProviders: [provider]
    });
    const states: AgentMentionSearchState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setFilter("issue");
    controller.updateQuery({ workspaceId: "workspace-1", query: "" });

    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    const groupId = "issue-topic:topic%2Fone";
    controller.expandGroup(groupId);
    controller.expandGroup(groupId);
    await vi.waitFor(() => expect(queryGroupPage).toHaveBeenCalledTimes(1));
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      groups: [
        {
          id: groupId,
          expandStatus: "loading",
          items: [expect.objectContaining({ targetId: "issue-1" })]
        },
        expect.objectContaining({ id: "issue-topic:topic%3Atwo" })
      ]
    });

    failedPage.reject(new Error("page unavailable"));
    await vi.waitFor(() =>
      expect(states.at(-1)?.groups[0]).toMatchObject({
        id: groupId,
        expandStatus: "error",
        hasMore: true
      })
    );

    controller.expandGroup(groupId);
    await vi.waitFor(() => expect(queryGroupPage).toHaveBeenCalledTimes(2));
    retryPage.resolve({
      id: "topic/one",
      label: "topic/one",
      items: [issue("issue-1", "topic/one"), issue("issue-2", "topic/one")],
      totalCount: 2
    });
    await vi.waitFor(() =>
      expect(states.at(-1)?.groups[0]).toMatchObject({
        id: groupId,
        expandStatus: "idle",
        hasMore: false,
        items: [
          expect.objectContaining({ targetId: "issue-1" }),
          expect.objectContaining({ targetId: "issue-2" })
        ]
      })
    );
    expect(pageSignals.every((signal) => !signal.aborted)).toBe(true);

    controller.close();
    const restored = new AgentMentionSearchController({
      contextMentionProviders: [provider]
    });
    const restoredStates: AgentMentionSearchState[] = [];
    restored.subscribe((state) => restoredStates.push(state));
    restored.setFilter("issue");
    restored.updateQuery({ workspaceId: "workspace-1", query: "" });

    expect(restoredStates.at(-1)?.groups[0]).toMatchObject({
      label: "Pinned",
      items: [
        expect.objectContaining({ targetId: "issue-1" }),
        expect.objectContaining({ targetId: "issue-2" })
      ]
    });
    await vi.waitFor(() => expect(queryGroups).toHaveBeenCalledTimes(2));
    expect(restoredStates.at(-1)?.groups[0]?.items).toHaveLength(2);

    refresh.resolve(
      groupedResult([
        {
          id: "topic/one",
          label: "Pinned refreshed",
          items: [issue("issue-4", "topic/one")],
          totalCount: 1
        }
      ])
    );
    await vi.waitFor(() =>
      expect(restoredStates.at(-1)?.groups[0]).toMatchObject({
        label: "Pinned refreshed",
        items: [expect.objectContaining({ targetId: "issue-4" })]
      })
    );
    expect(queryGroups).toHaveBeenCalledTimes(2);
  });

  it("preserves a page that completes while stale browse data revalidates", async () => {
    let now = 1_000;
    const refresh = deferred<RichTextTriggerGroupedQueryResult<TestIssue>>();
    const queryGroups = vi
      .fn()
      .mockResolvedValueOnce(
        groupedResult([
          {
            id: "topic/one",
            label: "Pinned",
            items: [issue("issue-1", "topic/one")],
            totalCount: 2,
            nextCursor: "cursor-1"
          }
        ])
      )
      .mockReturnValueOnce(refresh.promise);
    const provider = groupedIssueProvider({
      queryGroups,
      queryGroupPage: vi.fn(async () => ({
        id: "topic/one",
        label: "Pinned",
        items: [issue("issue-2", "topic/one")],
        totalCount: 2
      }))
    });
    const controller = new AgentMentionSearchController({
      browseCacheTtlMs: 0,
      contextMentionProviders: [provider],
      diagnosticNow: () => now
    });
    const states: AgentMentionSearchState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setFilter("issue");
    controller.updateQuery({ workspaceId: "workspace-1", query: "" });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    controller.close();
    now += 1;
    controller.updateQuery({ workspaceId: "workspace-1", query: "" });
    controller.setFilter("issue");
    await vi.waitFor(() => expect(queryGroups).toHaveBeenCalledTimes(2));
    controller.expandGroup("issue-topic:topic%2Fone");
    await vi.waitFor(() =>
      expect(states.at(-1)?.groups[0]?.items).toHaveLength(2)
    );

    refresh.resolve(
      groupedResult([
        {
          id: "topic/one",
          label: "Pinned refreshed",
          items: [issue("issue-1", "topic/one")],
          totalCount: 2,
          nextCursor: "cursor-1"
        }
      ])
    );

    await vi.waitFor(() =>
      expect(states.at(-1)?.groups[0]).toMatchObject({
        label: "Pinned refreshed",
        hasMore: false,
        items: [
          expect.objectContaining({ targetId: "issue-1" }),
          expect.objectContaining({ targetId: "issue-2" })
        ]
      })
    );
  });

  it("loads search pages with the active query and cursor while preserving stable entry keys", async () => {
    vi.useFakeTimers();
    const initialItems = Array.from({ length: 10 }, (_, index) =>
      issue(`issue-${index + 1}`, "topic/one")
    );
    const queryGroups = vi.fn(async () =>
      groupedResult([
        {
          id: "topic/one",
          label: "Pinned",
          items: initialItems,
          totalCount: 25,
          nextCursor: "cursor-1"
        }
      ])
    );
    const queryGroupPage = vi.fn(
      async ({ cursor }: RichTextTriggerGroupPageQueryInput) => ({
        id: "topic/one",
        label: "Pinned",
        items: Array.from(
          { length: cursor === "cursor-1" ? 10 : 5 },
          (_, index) =>
            issue(
              `issue-${index + (cursor === "cursor-1" ? 11 : 21)}`,
              "topic/one"
            )
        ),
        totalCount: 25,
        ...(cursor === "cursor-1" ? { nextCursor: "cursor-2" } : {})
      })
    );
    const controller = new AgentMentionSearchController({
      contextMentionProviders: [
        groupedIssueProvider({ queryGroups, queryGroupPage })
      ]
    });
    const states: AgentMentionSearchState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setFilter("issue");
    controller.updateQuery({ workspaceId: "workspace-1", query: " needle " });
    await vi.advanceTimersByTimeAsync(120);
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    const initialState = states.at(-1)!;
    const initialGroup = initialState.groups[0]!;
    const initialEntryKeys = flattenAgentMentionPaletteEntries(
      initialState
    ).map((entry) => entry.key);
    expect(mentionGroupExpandCount(initialGroup, "issue")).toBe(10);

    controller.expandGroup("issue-topic:topic%2Fone");
    await vi.waitFor(() => expect(queryGroupPage).toHaveBeenCalledTimes(1));
    expect(queryGroupPage).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "needle",
        groupId: "topic/one",
        cursor: "cursor-1",
        pageSize: 10
      })
    );
    await vi.waitFor(() =>
      expect(states.at(-1)?.groups[0]?.visibleCount).toBe(20)
    );

    const pagedState = states.at(-1)!;
    const pagedGroup = pagedState.groups[0]!;
    const pagedEntryKeys = flattenAgentMentionPaletteEntries(pagedState).map(
      (entry) => entry.key
    );
    expect(pagedGroup).toMatchObject({
      totalCount: 25,
      visibleCount: 20,
      hasMore: true,
      expandStatus: "idle"
    });
    expect(mentionGroupExpandCount(pagedGroup, "issue")).toBe(5);
    expect(pagedEntryKeys.slice(0, initialItems.length)).toEqual(
      initialEntryKeys.slice(0, initialItems.length)
    );
    expect(pagedEntryKeys.at(-1)).toBe("expand:issue-topic:topic%2Fone");

    controller.expandGroup("issue-topic:topic%2Fone");
    await vi.waitFor(() => expect(queryGroupPage).toHaveBeenCalledTimes(2));
    expect(queryGroupPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keyword: "needle",
        groupId: "topic/one",
        cursor: "cursor-2",
        pageSize: 10
      })
    );
    await vi.waitFor(() =>
      expect(states.at(-1)?.groups[0]).toMatchObject({
        totalCount: 25,
        visibleCount: 25,
        hasMore: false
      })
    );
  });

  it("cancels orphaned initial browse requests on every controller identity change", async () => {
    const runCase = async (
      suffix: string,
      change: (controller: AgentMentionSearchController) => void
    ): Promise<void> => {
      const signals: AbortSignal[] = [];
      const provider = groupedIssueProvider({
        queryGroups: vi.fn(
          ({ abortSignal }: RichTextTriggerQueryInput) =>
            new Promise<RichTextTriggerGroupedQueryResult<TestIssue>>(
              (_resolve, reject) => {
                signals.push(abortSignal!);
                abortSignal?.addEventListener(
                  "abort",
                  () => reject(abortError()),
                  { once: true }
                );
              }
            )
        )
      });
      const controller = new AgentMentionSearchController({
        contextMentionProviders: [provider]
      });
      controller.setFilter("issue");
      controller.updateQuery({
        workspaceId: `workspace-${suffix}`,
        query: ""
      });
      await vi.waitFor(() => expect(signals).toHaveLength(1));

      change(controller);
      expect(signals[0]?.aborted).toBe(true);
      controller.dispose();
      resetAgentMentionSearchBrowseCacheForTests();
    };

    await runCase("workspace", (controller) =>
      controller.updateQuery({ workspaceId: "workspace-next", query: "" })
    );
    await runCase("category", (controller) => controller.setFilter("app"));
    await runCase("query", (controller) =>
      controller.updateQuery({
        workspaceId: "workspace-query",
        query: "needle"
      })
    );
    await runCase("close", (controller) => controller.close());
    await runCase("dispose", (controller) => controller.dispose());
  });

  it("keeps a shared browse request alive until its final consumer closes", async () => {
    let providerSignal: AbortSignal | undefined;
    const queryGroups = vi.fn(
      ({ abortSignal }: RichTextTriggerQueryInput) =>
        new Promise<RichTextTriggerGroupedQueryResult<TestIssue>>(
          (_resolve, reject) => {
            providerSignal = abortSignal;
            abortSignal?.addEventListener("abort", () => reject(abortError()), {
              once: true
            });
          }
        )
    );
    const provider = groupedIssueProvider({ queryGroups });
    const first = new AgentMentionSearchController({
      contextMentionProviders: [provider]
    });
    const second = new AgentMentionSearchController({
      contextMentionProviders: [provider]
    });
    for (const controller of [first, second]) {
      controller.setFilter("issue");
      controller.updateQuery({ workspaceId: "workspace-shared", query: "" });
    }
    await vi.waitFor(() => expect(queryGroups).toHaveBeenCalledTimes(1));

    first.close();
    expect(providerSignal?.aborted).toBe(false);
    second.close();
    expect(providerSignal?.aborted).toBe(true);
  });

  it("aborts a pending topic page when the search query changes and ignores its late result", async () => {
    vi.useFakeTimers();
    const page = deferred<{
      id: string;
      label: string;
      items: TestIssue[];
      totalCount: number;
    }>();
    let pageSignal: AbortSignal | undefined;
    const provider = groupedIssueProvider({
      queryGroups: vi.fn(async ({ keyword }: RichTextTriggerQueryInput) =>
        groupedResult([
          {
            id: "topic/one",
            label: "Pinned",
            items: [issue(`${keyword || "browse"}-1`, "topic/one")],
            totalCount: 2,
            nextCursor: "cursor-1"
          }
        ])
      ),
      queryGroupPage: vi.fn((input) => {
        pageSignal = input.abortSignal;
        return page.promise;
      })
    });
    const controller = new AgentMentionSearchController({
      contextMentionProviders: [provider]
    });
    const states: AgentMentionSearchState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setFilter("issue");
    controller.updateQuery({ workspaceId: "workspace-1", query: "" });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    controller.expandGroup("issue-topic:topic%2Fone");
    await vi.waitFor(() => expect(pageSignal?.aborted).toBe(false));
    controller.updateQuery({ workspaceId: "workspace-1", query: "new" });
    expect(pageSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    page.resolve({
      id: "topic/one",
      label: "Pinned",
      items: [issue("late-2", "topic/one")],
      totalCount: 2
    });

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: "new",
        groups: [
          {
            items: [expect.objectContaining({ targetId: "new-1" })]
          }
        ]
      })
    );
    expect(
      states
        .at(-1)
        ?.groups[0]?.items.some(
          (item) =>
            item.kind === "workspace-issue" && item.targetId === "late-2"
        )
    ).toBe(false);
  });

  it("surfaces an initial grouped provider failure as the existing global error state", async () => {
    const controller = new AgentMentionSearchController({
      contextMentionProviders: [
        groupedIssueProvider({
          queryGroups: vi.fn().mockRejectedValue(new Error("topics failed"))
        })
      ]
    });
    const states: AgentMentionSearchState[] = [];
    controller.subscribe((state) => states.push(state));
    controller.setFilter("issue");
    controller.updateQuery({ workspaceId: "workspace-1", query: "" });

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "error",
        groups: [],
        error: "topics failed"
      })
    );
  });
});
