/**
 * 全局统一「文件类型筛选分类」—— 筛选与搜索在底层是同一能力:search() 接收的
 * filters 即此处的分类 id 数组,各源 daemon 按扩展名/媒体类型真正过滤。
 *
 * 这是分类口径的「单一 TS 来源」。Go 侧有一份逐字镜像:
 *   packages/workspace/referencefilter/categories.go
 * 两处扩展名清单必须保持一致 —— 改一处务必改另一处。
 */

export type ReferenceFilterCategoryId =
  | "image"
  | "document"
  | "spreadsheet"
  | "code"
  | "media"
  | "archive"
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
      "pptx"
    ]
  },
  {
    id: "spreadsheet",
    labelKey: "referencePicker.fileTypeSpreadsheet",
    extensions: ["xls", "xlsx", "csv", "tsv", "numbers"]
  },
  {
    id: "code",
    labelKey: "referencePicker.fileTypeCode",
    extensions: [
      "js",
      "jsx",
      "ts",
      "tsx",
      "py",
      "go",
      "java",
      "c",
      "h",
      "cpp",
      "cc",
      "rs",
      "rb",
      "php",
      "swift",
      "kt",
      "sh",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
      "html",
      "css",
      "scss",
      "sql"
    ]
  },
  {
    id: "media",
    labelKey: "referencePicker.fileTypeMedia",
    extensions: [
      "mp3",
      "wav",
      "flac",
      "aac",
      "ogg",
      "m4a",
      "mp4",
      "mov",
      "avi",
      "mkv",
      "webm"
    ]
  },
  {
    id: "archive",
    labelKey: "referencePicker.fileTypeArchive",
    extensions: ["zip", "tar", "gz", "tgz", "rar", "7z", "bz2"]
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
