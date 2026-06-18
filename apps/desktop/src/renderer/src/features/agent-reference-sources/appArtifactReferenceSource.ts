import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { createReferenceListSource } from "@tutti-os/workspace-file-reference/core";
import type {
  ReferenceSourceService,
  WorkspaceFileReferenceAdapter
} from "@tutti-os/workspace-file-reference/contracts";
import {
  createAppReferenceListBackend,
  listReferenceSupportingApps
} from "./appReferenceListBackend.ts";

export const APP_ARTIFACT_SOURCE_ID = "app-artifact";

/**
 * 应用产物源:遵循统一引用列表协议(backend = listWorkspaceAppReferences)。
 * 前端逻辑全部复用 createReferenceListSource;app 的 per-app 特殊性收在 backend 里。
 * open/preview 复用本地文件同一条 host 链路(解析绝对路径在 ~/.tutti 内,过 homedir 校验)。
 */
export function createAppArtifactReferenceSource(input: {
  tuttidClient: TuttidClient;
  adapter: WorkspaceFileReferenceAdapter;
  label: string;
  order?: number;
}): ReferenceSourceService {
  const { tuttidClient, adapter } = input;
  return createReferenceListSource({
    sourceId: APP_ARTIFACT_SOURCE_ID,
    label: input.label,
    order: input.order ?? 1,
    // 应用产物:全版布局——分组导航栏(app→项目)+ 文件类型筛选。
    // searchable:跨「声明 searchEndpoint」的 app 并行搜索(见 appReferenceListBackend.search)。
    // filterable:已选分类作为 search() 的 filters 下钻到各 app 的 searchEndpoint 过滤。
    capabilities: {
      searchable: true,
      previewable: true,
      paginated: true,
      navigable: true,
      filterable: true
    },
    async isAvailable(scope) {
      try {
        return (
          (await listReferenceSupportingApps(tuttidClient, scope)).length > 0
        );
      } catch {
        return false;
      }
    },
    backend: createAppReferenceListBackend(tuttidClient),
    adapter
  });
}
