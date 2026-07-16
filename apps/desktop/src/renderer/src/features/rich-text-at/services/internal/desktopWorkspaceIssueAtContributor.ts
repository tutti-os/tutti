import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "@tutti-os/agent-gui/context-mention-provider";
import { createRichTextTriggerProvider } from "@tutti-os/ui-rich-text/plugins";
import type {
  RichTextTriggerQueryGroup,
  RichTextTriggerQueryInput
} from "@tutti-os/ui-rich-text/types";
import { tuttiIssueAssetUrls } from "../../../../../../shared/tuttiAssetProtocol.ts";
import {
  compactMentionPresentation,
  compactStringRecord,
  createDesktopRichTextMentionInsertResult,
  resolveMentionSafely,
  scopeString,
  type DesktopRichTextAtContributor
} from "./desktopRichTextAtMentionSupport.ts";

interface WorkspaceIssueAtItem {
  content?: string | null;
  creatorDisplayName?: string | null;
  issueId: string;
  status?: string | null;
  title: string;
  topicId: string;
  workspaceId: string;
}

const WORKSPACE_ISSUE_PROVIDER_ID =
  AGENT_CONTEXT_MENTION_PROVIDER_IDS.workspaceIssue;
const WORKSPACE_ISSUE_MENTION_PAGE_SIZE = 10;
const WORKSPACE_ISSUE_TOPIC_QUERY_CONCURRENCY = 4;

export function createWorkspaceIssueAtContributor(
  tuttidClient: TuttidClient
): DesktopRichTextAtContributor {
  return {
    capability: "workspace-issue",
    getProviders(input) {
      return [
        createRichTextTriggerProvider<WorkspaceIssueAtItem>({
          id: WORKSPACE_ISSUE_PROVIDER_ID,
          trigger: "@",
          async query(searchInput) {
            const groups = await queryWorkspaceIssueMentionGroups({
              tuttidClient,
              workspaceId: input.workspaceId,
              searchInput
            });
            return mergeWorkspaceIssueMentionGroups(
              groups,
              workspaceIssueIdSearchKeyword(
                normalizeWorkspaceIssueSearchQuery(searchInput.keyword)
              )
            );
          },
          async queryGroups(searchInput) {
            return {
              groups: await queryWorkspaceIssueMentionGroups({
                tuttidClient,
                workspaceId: input.workspaceId,
                searchInput
              })
            };
          },
          async queryGroupPage(searchInput) {
            if (searchInput.abortSignal?.aborted) {
              return emptyWorkspaceIssueMentionGroup(searchInput.groupId);
            }
            const response = await tuttidClient.listWorkspaceIssues(
              input.workspaceId,
              {
                pageSize: searchInput.pageSize,
                pageToken: searchInput.cursor,
                searchQuery: normalizeWorkspaceIssueSearchQuery(
                  searchInput.keyword
                ),
                topicId: searchInput.groupId
              },
              { signal: searchInput.abortSignal }
            );
            if (searchInput.abortSignal?.aborted) {
              return emptyWorkspaceIssueMentionGroup(searchInput.groupId);
            }
            return {
              id: searchInput.groupId,
              label: searchInput.groupId,
              items: response.issues.map(workspaceIssueAtItemFromIssue),
              totalCount: response.totalCount,
              ...(response.nextPageToken
                ? { nextCursor: response.nextPageToken }
                : {})
            };
          },
          getItemKey: (item) => item.issueId,
          getItemLabel: (item) => item.title,
          getItemSubtitle: (item) =>
            [item.status, item.creatorDisplayName, item.content]
              .map((value) => value?.trim() ?? "")
              .filter(Boolean)
              .join(" · "),
          getItemIconUrl: () => tuttiIssueAssetUrls.default,
          toInsertResult(item) {
            return createDesktopRichTextMentionInsertResult({
              entityId: item.issueId,
              label: item.title,
              scope: compactStringRecord({
                topicId: item.topicId,
                workspaceId: item.workspaceId
              }),
              presentation: compactMentionPresentation({
                description: item.content?.trim() ?? "",
                iconUrl: tuttiIssueAssetUrls.default,
                status: item.status?.trim() ?? ""
              })
            });
          },
          async resolveMention(identity) {
            const workspaceId = scopeString(identity.scope, "workspaceId");
            if (!workspaceId) {
              return null;
            }
            return resolveMentionSafely(async () => {
              const response = await tuttidClient.getWorkspaceIssueDetail(
                workspaceId,
                identity.entityId
              );
              const issue = response.issue;
              return {
                label: issue.title,
                presentation: compactMentionPresentation({
                  description: issue.content,
                  iconUrl: tuttiIssueAssetUrls.default,
                  status: issue.status
                })
              };
            });
          }
        })
      ];
    }
  };
}

async function queryWorkspaceIssueMentionGroups(input: {
  tuttidClient: TuttidClient;
  workspaceId: string;
  searchInput: RichTextTriggerQueryInput;
}): Promise<RichTextTriggerQueryGroup<WorkspaceIssueAtItem>[]> {
  const { searchInput, tuttidClient, workspaceId } = input;
  if (searchInput.abortSignal?.aborted) {
    return [];
  }
  const topicResponse = await tuttidClient.listWorkspaceIssueTopics(
    workspaceId,
    { signal: searchInput.abortSignal }
  );
  if (searchInput.abortSignal?.aborted) {
    return [];
  }
  const searchQuery = normalizeWorkspaceIssueSearchQuery(searchInput.keyword);
  const groups = await mapWithConcurrency(
    topicResponse.topics,
    WORKSPACE_ISSUE_TOPIC_QUERY_CONCURRENCY,
    async (topic): Promise<RichTextTriggerQueryGroup<WorkspaceIssueAtItem>> => {
      const response = await tuttidClient.listWorkspaceIssues(
        workspaceId,
        {
          pageSize: WORKSPACE_ISSUE_MENTION_PAGE_SIZE,
          searchQuery,
          topicId: topic.topicId
        },
        { signal: searchInput.abortSignal }
      );
      return {
        id: topic.topicId,
        label: topic.title,
        items: response.issues.map(workspaceIssueAtItemFromIssue),
        totalCount: response.totalCount,
        ...(response.nextPageToken
          ? { nextCursor: response.nextPageToken }
          : {})
      };
    }
  );
  if (searchInput.abortSignal?.aborted) {
    return [];
  }

  const issueId = workspaceIssueIdSearchKeyword(searchQuery);
  if (
    issueId &&
    !groups.some((group) =>
      group.items.some((item) => item.issueId === issueId)
    )
  ) {
    const detail = await getWorkspaceIssueDetailSafely(
      tuttidClient,
      workspaceId,
      issueId
    );
    if (detail && !searchInput.abortSignal?.aborted) {
      const item = workspaceIssueAtItemFromIssue(detail.issue);
      const groupIndex = groups.findIndex((group) => group.id === item.topicId);
      if (groupIndex >= 0) {
        const group = groups[groupIndex];
        if (!group) {
          return groups.filter((candidate) => candidate.items.length > 0);
        }
        const items = [
          item,
          ...group.items.filter(
            (candidate) => candidate.issueId !== item.issueId
          )
        ];
        groups[groupIndex] = {
          ...group,
          items,
          totalCount: Math.max(group.totalCount, items.length)
        };
      } else {
        groups.push({
          id: item.topicId,
          label: item.topicId,
          items: [item],
          totalCount: 1
        });
      }
    }
  }

  return groups.filter((group) => group.items.length > 0);
}

function mergeWorkspaceIssueMentionGroups(
  groups: readonly RichTextTriggerQueryGroup<WorkspaceIssueAtItem>[],
  exactIssueId: string | null
): WorkspaceIssueAtItem[] {
  const items: WorkspaceIssueAtItem[] = [];
  const seenIssueIds = new Set<string>();
  if (exactIssueId) {
    const exactItem = groups
      .flatMap((group) => group.items)
      .find((item) => item.issueId === exactIssueId);
    if (exactItem) {
      items.push(exactItem);
      seenIssueIds.add(exactItem.issueId);
    }
  }

  const maxGroupLength = Math.max(
    0,
    ...groups.map((group) => group.items.length)
  );
  for (let itemIndex = 0; itemIndex < maxGroupLength; itemIndex += 1) {
    for (const group of groups) {
      const item = group.items[itemIndex];
      if (!item || seenIssueIds.has(item.issueId)) {
        continue;
      }
      items.push(item);
      seenIssueIds.add(item.issueId);
    }
  }
  return items;
}

function emptyWorkspaceIssueMentionGroup(
  topicId: string
): RichTextTriggerQueryGroup<WorkspaceIssueAtItem> {
  return { id: topicId, label: topicId, items: [], totalCount: 0 };
}

function normalizeWorkspaceIssueSearchQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Map<number, TOutput>();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      results.set(index, await mapper(inputs[index] as TInput));
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), inputs.length) },
      worker
    )
  );
  return inputs.map((_, index) => results.get(index) as TOutput);
}

async function getWorkspaceIssueDetailSafely(
  tuttidClient: TuttidClient,
  workspaceId: string,
  issueId: string
): Promise<Awaited<
  ReturnType<TuttidClient["getWorkspaceIssueDetail"]>
> | null> {
  try {
    return await tuttidClient.getWorkspaceIssueDetail(workspaceId, issueId);
  } catch {
    return null;
  }
}

function workspaceIssueAtItemFromIssue(issue: {
  content?: string | null;
  creatorDisplayName?: string | null;
  issueId: string;
  status?: string | null;
  title: string;
  topicId: string;
  workspaceId: string;
}): WorkspaceIssueAtItem {
  return {
    content: issue.content,
    creatorDisplayName: issue.creatorDisplayName,
    issueId: issue.issueId,
    status: issue.status,
    title: issue.title,
    topicId: issue.topicId,
    workspaceId: issue.workspaceId
  };
}

function workspaceIssueIdSearchKeyword(keyword: string): string | null {
  const issueId = keyword.trim();
  return /^issue-[A-Za-z0-9_-]+$/.test(issueId) ? issueId : null;
}
