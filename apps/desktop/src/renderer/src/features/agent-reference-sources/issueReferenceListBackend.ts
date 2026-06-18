import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { IssueManagerIssueDetailResponse } from "@tutti-os/client-tuttid-ts";
import type {
  ReferenceListBackend,
  ReferenceListItem,
  ReferenceListResult
} from "@tutti-os/workspace-file-reference/core";
import {
  base64UrlDecode,
  base64UrlEncode
} from "@tutti-os/workspace-file-reference/core";
import type { ReferenceScope } from "@tutti-os/workspace-file-reference/contracts";
// 「事项」应用图标:与 dock / workbench 节点同一份资源。引用 picker 的二级分组、
// 以及折叠成 bundle 后在 agent GUI 面板里的 chip,都靠这个真实 iconUrl 展示应用图标
// (与「引用 app 文件夹」一致——app 源同样在 group 上挂 iconUrl)。
import issueAppIconUrl from "@tutti-os/workspace-issue-manager/assets/workspace-dock-task.png";

/**
 * 议题产出文件的引用列表 backend(遵循统一协议)。
 * 层级:topic → issue → 产出文件(latestOutputs)。逐层调 issue API,getDetail 按 issueId 缓存。
 *   t:{topicId}  i:{issueId}
 */

const ISSUE_PAGE_SIZE = 50;

type DecodedGroup =
  | { kind: "topic"; topicId: string }
  | { kind: "issue"; issueId: string };

export function createIssueReferenceListBackend(
  tuttidClient: TuttidClient
): ReferenceListBackend {
  const detailCache = new Map<
    string,
    Promise<IssueManagerIssueDetailResponse>
  >();
  const getDetail = (workspaceId: string, issueId: string) => {
    let pending = detailCache.get(issueId);
    if (!pending) {
      pending = tuttidClient.getWorkspaceIssueDetail(workspaceId, issueId);
      detailCache.set(issueId, pending);
    }
    return pending;
  };
  // 议题「文件夹下的文件数量」= 产出文件(latestOutputs)条数。
  // listWorkspaceIssues 不带产出计数,只能逐 issue 取 detail;getDetail 已按 issueId 缓存,
  // 后续下钻进该议题列产出时零额外请求。单个 detail 失败不拖垮整列——失败时省略计数(不展示徽标)。
  const outputCountOf = async (
    workspaceId: string,
    issueId: string
  ): Promise<number | undefined> => {
    try {
      return (await getDetail(workspaceId, issueId)).latestOutputs.length;
    } catch {
      return undefined;
    }
  };

  return {
    async list(
      scope: ReferenceScope,
      { parentGroupId, cursor, filter }
    ): Promise<ReferenceListResult> {
      const workspaceId = scope.workspaceId;

      // 根层级:topics。
      if (!parentGroupId) {
        const response =
          await tuttidClient.listWorkspaceIssueTopics(workspaceId);
        return {
          items: response.topics.map((topic) => ({
            type: "group",
            id: encodeGroup("t", topic.topicId),
            displayName: topic.title?.trim() || topic.topicId,
            iconUrl: issueAppIconUrl
          })),
          nextCursor: null
        };
      }

      const decoded = decodeGroup(parentGroupId);

      // topic → issues(分页)。
      if (decoded.kind === "topic") {
        const response = await tuttidClient.listWorkspaceIssues(workspaceId, {
          topicId: decoded.topicId,
          pageSize: ISSUE_PAGE_SIZE,
          ...(cursor ? { pageToken: cursor } : {}),
          ...(filter ? { searchQuery: filter } : {})
        });
        // 每个议题就是一个「项目文件夹」:挂「事项」应用图标 + 产出文件数量,
        // 与「引用 app 文件夹」表现一致。计数逐 issue 并行取(getDetail 缓存,失败容错)。
        const items: ReferenceListItem[] = await Promise.all(
          response.issues.map(async (issue) => {
            const referenceCount = await outputCountOf(
              workspaceId,
              issue.issueId
            );
            return {
              type: "group",
              id: encodeGroup("i", issue.issueId),
              displayName: issue.title?.trim() || issue.issueId,
              iconUrl: issueAppIconUrl,
              ...(referenceCount == null ? {} : { referenceCount })
            };
          })
        );
        return {
          items,
          nextCursor: response.nextPageToken ?? null
        };
      }

      // issue → 直接列产出文件(latestOutputs)。
      const detail = await getDetail(workspaceId, decoded.issueId);
      // 归属标签 = 所属议题标题(搜索结果副标题用)。
      const issueLabel = detail.issue?.title?.trim() || decoded.issueId;
      const items: ReferenceListItem[] = detail.latestOutputs.map((output) => ({
        type: "reference",
        reference: {
          path: output.path,
          displayName: output.displayName,
          parentLabel: issueLabel,
          sizeBytes: output.sizeBytes,
          mimeType: output.mediaType || null,
          mtimeMs: unixSecondsToMs(output.createdAtUnix)
        }
      }));
      return { items, nextCursor: null };
    },

    // 源级搜索:按文件名搜产出文件(daemon 端跨议题 LIKE 查询)。
    //  - withinGroupId 指定某议题(i:)/topic(t:)时,把搜索限定到该范围;
    //  - 否则跨整个 workspace 的议题产出搜索。
    // 归属标签 = 所属议题标题(搜索结果副标题);daemon 已按时间倒序去重,不分页。
    async search(
      scope: ReferenceScope,
      { query, limit, filters, withinGroupId }
    ): Promise<ReferenceListResult> {
      const workspaceId = scope.workspaceId;
      const decodedScope = withinGroupId ? decodeGroup(withinGroupId) : null;
      const response = await tuttidClient.searchWorkspaceIssueReferences(
        workspaceId,
        {
          query,
          ...(limit == null ? {} : { limit }),
          ...(filters && filters.length > 0 ? { filters } : {}),
          ...(decodedScope?.kind === "issue"
            ? { issueId: decodedScope.issueId }
            : {}),
          ...(decodedScope?.kind === "topic"
            ? { topicId: decodedScope.topicId }
            : {})
        }
      );
      const items: ReferenceListItem[] = response.items.map((hit) => ({
        type: "reference",
        reference: {
          path: hit.output.path,
          displayName: hit.output.displayName,
          parentLabel: hit.issueTitle?.trim() || hit.output.issueId,
          sizeBytes: hit.output.sizeBytes,
          mimeType: hit.output.mediaType || null,
          mtimeMs: unixSecondsToMs(hit.output.createdAtUnix)
        }
      }));
      return { items, nextCursor: null };
    },

    // 定位:层级 topic → issue → 产出。带 topicId 时给出完整路径(展开 topic 再进入事项);
    // 缺 topicId 时直接定位到事项分组(backend.list 对 `i:` 直接列产出,内容仍正确)。
    locate(_scope, params): Promise<string[] | null> {
      const issueId = params.issueId?.trim();
      if (!issueId) {
        return Promise.resolve(null);
      }
      const topicId = params.topicId?.trim();
      const issuePath = encodeGroup("i", issueId);
      return Promise.resolve(
        topicId ? [encodeGroup("t", topicId), issuePath] : [issuePath]
      );
    }
  };
}

function encodeGroup(prefix: "t" | "i", id: string): string {
  return `${prefix}:${base64UrlEncode(id)}`;
}

function decodeGroup(parentGroupId: string): DecodedGroup {
  const markerIndex = parentGroupId.indexOf(":");
  const prefix = parentGroupId.slice(0, markerIndex);
  const id = base64UrlDecode(parentGroupId.slice(markerIndex + 1));
  switch (prefix) {
    case "t":
      return { kind: "topic", topicId: id };
    case "i":
      return { kind: "issue", issueId: id };
    default:
      throw new Error(`invalid issue parentGroupId: ${parentGroupId}`);
  }
}

function unixSecondsToMs(
  unixSeconds: number | null | undefined
): number | null {
  return unixSeconds == null ? null : unixSeconds * 1000;
}
