/**
 * 全局统一「文件类型筛选分类」。浏览态递归投影源树并仅保留含匹配文件的目录;
 * 关键字搜索时,search() 接收的 filters 即此处的分类 id 数组,各源 daemon 在
 * 分页/limit 前按扩展名或媒体类型过滤。
 *
 * 这是分类口径的「单一 TS 来源」。其余各处均为逐字镜像,改一处务必同步全部:
 *   - Go 宿主侧:services/tuttid/data/workspace/reference_filter_categories.go
 *   - group-chat 应用:apps/server/src/domains/reference-filter-categories.ts
 *   - vibe-design 应用:server/src/routes/references-routes.ts
 *   - ai-media-canvas 应用:apps/server/src/http/references.ts
 *   - app_factory 技能契约:app_factory_reference/references/manifest-contract.md
 *
 * 分类口径:image(图片)/ video(视频)/ document(文档,含表格)/ webpage(网页)/ other(其他)。
 * 音频、代码、压缩包等未单列扩展名,统一归入 "other" 兜底。
 */

export type ReferenceFilterCategoryId =
  | "image"
  | "video"
  | "document"
  | "webpage"
  | "other";

export interface ReferenceFilterCategory {
  id: ReferenceFilterCategoryId;
  /** 展示名走 i18n:referencePicker 命名空间下的 copy key,由 UI 层解析。 */
  labelKey: string;
  /** 该分类归属的文件扩展名(小写,不含点)。"other" 为空,表示「未收录/无扩展名」兜底。 */
  extensions: readonly string[];
}

/**
 * 分类定义(展示顺序即数组顺序)。每个分类按文件扩展名归类;
 * 文件夹不参与类型过滤(始终保留以便继续下钻)。
 */
export const REFERENCE_FILTER_CATEGORIES: readonly ReferenceFilterCategory[] = [
  {
    id: "image",
    labelKey: "referencePicker.fileTypeImage",
    extensions: [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "svg",
      "bmp",
      "ico",
      "heic"
    ]
  },
  {
    id: "video",
    labelKey: "referencePicker.fileTypeVideo",
    extensions: ["mp4", "mov", "avi", "mkv", "webm"]
  },
  {
    id: "document",
    labelKey: "referencePicker.fileTypeDocument",
    extensions: [
      "pdf",
      "doc",
      "docx",
      "txt",
      "md",
      "markdown",
      "rtf",
      "odt",
      "pages",
      "key",
      "ppt",
      "pptx",
      "xls",
      "xlsx",
      "csv",
      "tsv",
      "numbers"
    ]
  },
  {
    id: "webpage",
    labelKey: "referencePicker.fileTypeWebpage",
    extensions: ["html", "htm", "mhtml", "url", "webloc"]
  },
  { id: "other", labelKey: "referencePicker.fileTypeOther", extensions: [] }
];

const CATEGORY_BY_EXTENSION: ReadonlyMap<string, ReferenceFilterCategoryId> =
  new Map(
    REFERENCE_FILTER_CATEGORIES.flatMap((category) =>
      category.extensions.map((ext) => [ext, category.id] as const)
    )
  );

/** 从文件名末段推断分类;无扩展名或未收录的扩展名归入「other」。 */
export function categoryOfFileName(name: string): ReferenceFilterCategoryId {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return "other";
  }
  const ext = name.slice(dotIndex + 1).toLowerCase();
  return CATEGORY_BY_EXTENSION.get(ext) ?? "other";
}

/**
 * 分类筛选判定:空 ids = 不筛选(全部通过);文件夹始终通过(保留导航能力);
 * 仅对文件按其分类匹配。供需要在客户端兜底过滤的调用方复用。
 */
export function matchesFilterCategories(
  name: string,
  isFolder: boolean,
  filterIds: readonly string[]
): boolean {
  if (filterIds.length === 0 || isFolder) {
    return true;
  }
  return filterIds.includes(categoryOfFileName(name));
}
