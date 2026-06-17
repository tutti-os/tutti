import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
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

/**
 * 应用产物的引用列表 backend(遵循统一协议)。
 * 根层列支持 references 的 app;进入某 app 后按 parentGroupId/cursor 走 listWorkspaceAppReferences。
 * 因 references 是 per-app,app 维度被编进协议的 group id 里(app: / grp: 段)。
 */

const APP_REFERENCE_PAGE_LIMIT = 50;
const APP_MARKER = "app:";
const GROUP_MARKER = "|grp:";

type AppReferenceListItem = Awaited<
  ReturnType<TuttidClient["listWorkspaceAppReferences"]>
>["items"][number];

export function createAppReferenceListBackend(
  tuttidClient: TuttidClient
): ReferenceListBackend {
  return {
    async list(
      scope: ReferenceScope,
      { parentGroupId, cursor, filter }
    ): Promise<ReferenceListResult> {
      // 根层级:列支持 references 的 app。
      if (!parentGroupId) {
        const apps = await listReferenceSupportingApps(tuttidClient, scope);
        return {
          items: apps.map((app) => ({
            type: "group",
            id: `${APP_MARKER}${app.appId}`,
            displayName: app.displayName?.trim() || app.appId,
            iconUrl: app.iconUrl
          })),
          nextCursor: null
        };
      }

      const { appId, groupId } = decodeAppGroupId(parentGroupId);
      const response = await tuttidClient.listWorkspaceAppReferences(
        scope.workspaceId,
        appId,
        {
          parentGroupId: groupId,
          filterText: filter ?? null,
          cursor: cursor ?? null,
          limit: APP_REFERENCE_PAGE_LIMIT,
          kinds: ["file"]
        }
      );
      return {
        items: response.items.map((item) => appItemToProtocol(appId, item)),
        nextCursor: response.nextCursor ?? null
      };
    },

    // 源级搜索:app 引用是 per-app 的,daemon 搜索接口也是 per-app,
    // 故跨所有「声明 searchEndpoint(searchSupported)」的 app 并行搜索后合并。
    // 各 app 内部已按相关性排序;v1 按 app 顺序拼接,不做跨 app 全局重排,不分页。
    async search(
      scope: ReferenceScope,
      { query, limit }
    ): Promise<ReferenceListResult> {
      const apps = (
        await listReferenceSupportingApps(tuttidClient, scope)
      ).filter((app) => app.references.searchSupported);
      if (apps.length === 0) {
        return { items: [], nextCursor: null };
      }
      const perApp = await Promise.all(
        apps.map(async (app) => {
          try {
            const response = await tuttidClient.searchWorkspaceAppReferences(
              scope.workspaceId,
              app.appId,
              {
                query,
                ...(limit == null ? {} : { limit }),
                kinds: ["file"]
              }
            );
            return response.items.map((item) =>
              appItemToProtocol(app.appId, item)
            );
          } catch {
            return [];
          }
        })
      );
      const items = perApp.flat();
      return {
        items: limit == null ? items : items.slice(0, limit),
        nextCursor: null
      };
    }
  };
}

export async function listReferenceSupportingApps(
  tuttidClient: TuttidClient,
  scope: ReferenceScope
) {
  const response = await tuttidClient.listWorkspaceApps(scope.workspaceId);
  return response.apps.filter(
    (app) => app.references.listSupported && app.installed && app.enabled
  );
}

function appItemToProtocol(
  appId: string,
  item: AppReferenceListItem
): ReferenceListItem {
  if (item.type === "group") {
    return {
      type: "group",
      id: `${APP_MARKER}${appId}${GROUP_MARKER}${base64UrlEncode(item.id)}`,
      displayName: item.displayName,
      referenceCount: item.referenceCount
    };
  }
  const reference = item.reference;
  return {
    type: "reference",
    reference: {
      path: reference.path,
      displayName: reference.displayName,
      sizeBytes: reference.sizeBytes,
      mtimeMs: reference.mtimeMs,
      mimeType: reference.mimeType
    }
  };
}

function decodeAppGroupId(parentGroupId: string): {
  appId: string;
  groupId: string | null;
} {
  if (!parentGroupId.startsWith(APP_MARKER)) {
    throw new Error(`invalid app parentGroupId: ${parentGroupId}`);
  }
  const body = parentGroupId.slice(APP_MARKER.length);
  const markerIndex = body.indexOf(GROUP_MARKER);
  if (markerIndex < 0) {
    return { appId: body, groupId: null };
  }
  return {
    appId: body.slice(0, markerIndex),
    groupId: base64UrlDecode(body.slice(markerIndex + GROUP_MARKER.length))
  };
}
