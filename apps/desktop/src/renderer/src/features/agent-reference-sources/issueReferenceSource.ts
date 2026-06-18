import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { createReferenceListSource } from "@tutti-os/workspace-file-reference/core";
import type {
  ReferenceSourceService,
  WorkspaceFileReferenceAdapter
} from "@tutti-os/workspace-file-reference/contracts";
import { createIssueReferenceListBackend } from "./issueReferenceListBackend.ts";

export const ISSUE_SOURCE_ID = "issue-file";

/**
 * 议题文件源:topic → issue → 关联文件夹/产出文件夹 → 文件,遵循统一引用列表协议。
 * isAvailable 恒 true(议题 tab 一定显示)。open/preview 复用 host 链路。
 */
export function createIssueReferenceSource(input: {
  tuttidClient: TuttidClient;
  adapter: WorkspaceFileReferenceAdapter;
  label: string;
  order?: number;
}): ReferenceSourceService {
  return createReferenceListSource({
    sourceId: ISSUE_SOURCE_ID,
    label: input.label,
    order: input.order ?? 2,
    // 二级分组(各议题)用「事项」应用图标作为兜底,替代默认文件夹图标。
    icon: "issue",
    capabilities: {
      searchable: true,
      previewable: true,
      paginated: true,
      navigable: true,
      filterable: true
    },
    isAvailable: () => true,
    backend: createIssueReferenceListBackend(input.tuttidClient),
    adapter: input.adapter
  });
}
