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
import type {
  ReferenceHandle,
  ReferenceScope
} from "@tutti-os/workspace-file-reference/contracts";

/**
 * 应用产物的引用列表 backend(遵循统一协议)。
 * 根层列支持 references 的 app;进入某 app 后按 parentGroupId/cursor 走 listWorkspaceAppReferences。
 * 因 references 是 per-app,app 维度被编进协议的 group id 里(app: / grp: 段)。
 */

const APP_REFERENCE_PAGE_LIMIT = 200;
const APP_MARKER = "app:";
const GROUP_MARKER = "|grp:";
const REFERENCE_SUPPORTING_APPS_CACHE_TTL_MS = 2_000;

type AppReferenceListItem = Awaited<
  ReturnType<TuttidClient["listWorkspaceAppReferences"]>
>["items"][number];
type ReferenceSupportingApp = Awaited<
  ReturnType<TuttidClient["listWorkspaceApps"]>
>["apps"][number];
type ReferenceSupportingAppsCacheEntry = {
  expiresAt: number;
  promise: Promise<ReferenceSupportingApp[]>;
};

const referenceSupportingAppsCache = new WeakMap<
  TuttidClient,
  Map<string, ReferenceSupportingAppsCacheEntry>
>();

export function createAppReferenceListBackend(
  tuttidClient: TuttidClient
): ReferenceListBackend {
  // app 元数据缓存:把 app 展示名/图标透传到其下所有分组节点(项目/子文件夹),
  // 使「引用应用项目」的详情与 bundle 都使用人类可读上下文。
  const appLabelById = new Map<string, string>();
  const appIconById = new Map<string, string>();
  const rememberApps = (
    apps: Awaited<ReturnType<typeof listReferenceSupportingApps>>
  ) => {
    for (const app of apps) {
      appLabelById.set(app.appId, app.displayName?.trim() || app.appId);
      if (app.iconUrl) {
        appIconById.set(app.appId, app.iconUrl);
      }
    }
  };
  const ensureAppMetadata = async (
    scope: ReferenceScope,
    appId: string
  ): Promise<{ label: string | undefined; iconUrl: string | undefined }> => {
    if (appLabelById.has(appId) || appIconById.has(appId)) {
      return {
        label: appLabelById.get(appId),
        iconUrl: appIconById.get(appId)
      };
    }
    const apps = await listReferenceSupportingApps(tuttidClient, scope);
    rememberApps(apps);
    return {
      label: appLabelById.get(appId),
      iconUrl: appIconById.get(appId)
    };
  };

  return {
    async list(
      scope: ReferenceScope,
      { parentGroupId, cursor, filter }
    ): Promise<ReferenceListResult> {
      // 根层级:列支持 references 的 app。
      if (!parentGroupId) {
        const apps = await listReferenceSupportingApps(tuttidClient, scope);
        rememberApps(apps);
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
      const [response, appMetadata] = await Promise.all([
        tuttidClient.listWorkspaceAppReferences(scope.workspaceId, appId, {
          parentGroupId: groupId,
          filterText: filter ?? null,
          cursor: cursor ?? null,
          limit: APP_REFERENCE_PAGE_LIMIT,
          kinds: ["file"]
        }),
        ensureAppMetadata(scope, appId)
      ]);
      return {
        items: response.items.map((item) =>
          appItemToProtocol(appId, item, appMetadata.label, appMetadata.iconUrl)
        ),
        nextCursor: response.nextCursor ?? null
      };
    },

    // 源级搜索:app 引用是 per-app 的,daemon 搜索接口也是 per-app。
    //  - withinGroupId 指定了某个 app 分组(左栏选中的应用)时,只搜该应用;
    //  - 否则跨所有「声明 searchEndpoint(searchSupported)」的 app 并行搜索后合并。
    // 各 app 内部已按相关性排序;v1 按 app 顺序拼接,不做跨 app 全局重排,不分页。
    async search(
      scope: ReferenceScope,
      { query, limit, filters, withinGroupId }
    ): Promise<ReferenceListResult> {
      // 选中分组节点解码出 appId(分组形如 `app:${appId}` 或更深的 `app:${appId}|grp:…`),
      // 把搜索限定到该应用;无 scope 时回退跨全部应用。
      const decodedScope = withinGroupId
        ? decodeAppGroupId(withinGroupId)
        : null;
      const scopedAppId = decodedScope?.appId ?? null;
      const scopedGroupId = decodedScope?.groupId ?? null;
      const apps = (await listReferenceSupportingApps(tuttidClient, scope))
        .filter((app) => app.references.searchSupported)
        .filter((app) => scopedAppId == null || app.appId === scopedAppId);
      if (apps.length === 0) {
        // 没有任何 app 声明 references.searchEndpoint —— 搜索必空,日志便于排查。
        console.warn("[app-reference-search] no searchSupported apps", {
          workspaceId: scope.workspaceId,
          query
        });
        return { items: [], nextCursor: null };
      }
      const perApp = await Promise.all(
        apps.map(async (app) => {
          try {
            const appLabel = app.displayName?.trim() || app.appId;
            const appIconUrl = app.iconUrl ?? undefined;
            const queryText = query.trim();
            const shouldSearchGroups =
              queryText.length > 0 &&
              scopedGroupId == null &&
              (!filters || filters.length === 0);
            const [groupResponse, searchResponse] = await Promise.all([
              shouldSearchGroups
                ? tuttidClient.listWorkspaceAppReferences(
                    scope.workspaceId,
                    app.appId,
                    {
                      parentGroupId: null,
                      filterText: queryText,
                      cursor: null,
                      limit: limit ?? APP_REFERENCE_PAGE_LIMIT,
                      kinds: ["file"]
                    }
                  )
                : Promise.resolve({ items: [], nextCursor: null }),
              tuttidClient.searchWorkspaceAppReferences(
                scope.workspaceId,
                app.appId,
                {
                  query,
                  ...(limit == null ? {} : { limit }),
                  ...(filters && filters.length > 0 ? { filters } : {}),
                  kinds: ["file"]
                }
              )
            ]);
            const groupItems = groupResponse.items
              .filter((item) => item.type === "group")
              .map((item) =>
                appItemToProtocol(app.appId, item, appLabel, appIconUrl)
              );
            const fileItems = searchResponse.items.map((item) =>
              appItemToProtocol(app.appId, item, appLabel)
            );
            const mapped = [...groupItems, ...fileItems];
            // daemon 仅在 app 运行时才代理到其 server,否则静默返回空。
            // 记录每个 app 的命中数,便于区分「没起/没匹配/接口异常」。
            console.debug("[app-reference-search] app result", {
              appId: app.appId,
              query,
              groupCount: groupItems.length,
              fileCount: fileItems.length,
              count: mapped.length
            });
            return mapped;
          } catch (error) {
            // 单 app 失败不影响其他 app —— 但别再静默吞掉,打日志暴露原因。
            console.warn("[app-reference-search] app search failed", {
              appId: app.appId,
              query,
              error
            });
            return [];
          }
        })
      );
      const items = perApp.flat();
      return {
        items: limit == null ? items : items.slice(0, limit),
        nextCursor: null
      };
    },

    // 定位:应用是根层级分组(`app:${appId}`);带 groupId 时再下钻到该子分组
    // (`app:${appId}|grp:${b64(groupId)}`),供点击引用 chip 一键定位到具体项目。
    locate(_scope, params): Promise<string[] | null> {
      const appId = params.appId?.trim();
      if (!appId) {
        return Promise.resolve(null);
      }
      const appPath = `${APP_MARKER}${appId}`;
      const groupId = params.groupId?.trim();
      return Promise.resolve(
        groupId
          ? [appPath, `${appPath}${GROUP_MARKER}${base64UrlEncode(groupId)}`]
          : [appPath]
      );
    },

    // 句柄解码:`app:${appId}` / `app:${appId}|grp:${groupId}` → { source:"app", id:appId, groupId? }。
    describeHandle(groupId): ReferenceHandle | null {
      const { appId, groupId: subGroupId } = decodeAppGroupId(groupId);
      if (!appId) {
        return null;
      }
      return {
        source: "app",
        id: appId,
        ...(subGroupId ? { groupId: subGroupId } : {})
      };
    }
  };
}

export async function listReferenceSupportingApps(
  tuttidClient: TuttidClient,
  scope: ReferenceScope
) {
  const workspaceID = scope.workspaceId;
  let clientCache = referenceSupportingAppsCache.get(tuttidClient);
  if (!clientCache) {
    clientCache = new Map();
    referenceSupportingAppsCache.set(tuttidClient, clientCache);
  }
  const now = Date.now();
  const cached = clientCache.get(workspaceID);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = tuttidClient
    .listWorkspaceApps(workspaceID)
    .then((response) =>
      response.apps.filter(
        (app) => app.references.listSupported && app.installed && app.enabled
      )
    );
  clientCache.set(workspaceID, {
    expiresAt: now + REFERENCE_SUPPORTING_APPS_CACHE_TTL_MS,
    promise
  });
  void promise.catch(() => {
    if (clientCache.get(workspaceID)?.promise === promise) {
      clientCache.delete(workspaceID);
    }
  });
  return promise;
}

function appItemToProtocol(
  appId: string,
  item: AppReferenceListItem,
  // 搜索结果归属标签的兜底(应用名);仅搜索拍平时传入,逐层 list(浏览)不需要。
  // 优先用 app 自报的所属项目名(reference.parentGroupLabel),缺省才回退到应用名。
  appFallbackLabel?: string,
  // app 图标:透传到分组节点,使「引用应用项目」的 bundle 带应用图标。
  appIconUrl?: string
): ReferenceListItem {
  if (item.type === "group") {
    const groupLabel = item.displayName?.trim();
    return {
      type: "group",
      id: `${APP_MARKER}${appId}${GROUP_MARKER}${base64UrlEncode(item.id)}`,
      displayName: item.displayName,
      ...(appFallbackLabel && groupLabel
        ? { parentLabel: `${appFallbackLabel} / ${groupLabel}` }
        : {}),
      referenceCount: item.referenceCount,
      ...(appIconUrl ? { iconUrl: appIconUrl } : {})
    };
  }
  const reference = item.reference;
  const parentLabel = reference.parentGroupLabel?.trim() || appFallbackLabel;
  return {
    type: "reference",
    reference: {
      path: reference.path,
      displayName: reference.displayName,
      ...(parentLabel ? { parentLabel } : {}),
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
