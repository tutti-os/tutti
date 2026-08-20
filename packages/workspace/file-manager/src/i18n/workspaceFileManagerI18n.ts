import {
  createScopedLocaleObjectsI18nModuleManifest,
  createScopedI18nRuntime,
  type I18nDictionary,
  type I18nRuntime
} from "@tutti-os/ui-i18n-runtime";

type WorkspaceFileManagerI18nLocale = "en" | "zh-CN";
export const workspaceFileManagerI18nNamespace = "workspaceFileManager";
export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
  localeObjectByLocale: {
    en: "workspaceFileManagerEn",
    "zh-CN": "workspaceFileManagerZhCN"
  },
  name: "workspace-file-manager",
  namespace: "workspaceFileManager",
  sourceRoot: "packages/workspace/file-manager/src"
});

const workspaceFileManagerEn = {
  backLabel: "Back",
  arrangeApplicationLabel: "Application",
  arrangeCreatedLabel: "Created",
  arrangeDateAddedLabel: "Date Added",
  arrangeKindLabel: "Kind",
  arrangeLastOpenedLabel: "Last Opened",
  arrangeMenuLabel: "Arrange",
  arrangeNoneLabel: "None",
  breadcrumbRootLabel: "workspace",
  cancelLabel: "Cancel",
  closeLabel: "Close",
  copyLabel: "Copy",
  copyPathLabel: "Copy path",
  copyPathSuccessTitle: "Path copied",
  copySuccessTitle: "Copied to clipboard",
  createActionLabel: "Create",
  createDirectoryLabel: "New folder",
  createDirectoryPlaceholder: "Folder name",
  createFileLabel: "New file",
  createFilePlaceholder: "File name",
  createNameInvalid: "Use a valid name without path separators",
  createNameRequired: "Enter a name to continue",
  createNameTooLong: "Names must be 255 UTF-8 bytes or fewer",
  clearSearchLabel: "Clear search",
  deleteConfirmDescription: "Delete {{name}} from this workspace?",
  deleteLabel: "Delete",
  deletingLabel: "Deleting...",
  downloadFailedTitle: "Download failed",
  downloadLabel: "Download",
  emptyDirectory: "No visible files in this folder",
  collapseFolderLabel: "Collapse folder",
  expandFolderLabel: "Expand folder",
  forwardLabel: "Forward",
  loading: "Loading",
  modifiedLabel: "Modified",
  nameLabel: "Name",
  noSearchResults: "No files matched your search",
  openFailedTitle: "Open failed",
  openLabel: "Open",
  openInAppBrowserLabel: "Tutti built-in browser",
  openInDefaultBrowserLabel: "Default Browser",
  openInFileViewerLabel: "File viewer",
  openWithLabel: "Open With",
  openWithLoadingLabel: "Loading apps...",
  openWithOtherLabel: "Other...",
  openWithOtherPickerPrompt: "Choose an application to open this file:",
  revealInFileExplorerLabel: "Reveal in File Explorer",
  revealInFileManagerLabel: "Reveal in File Manager",
  revealInFinderLabel: "Reveal in Finder",
  shareLabel: "Share",
  unknownErrorMessage: "Something went wrong. Please try again.",
  previewActionsLabel: "File actions",
  previewBinary:
    "This file looks binary, so the preview stays read-only for now.",
  previewDecodeFailed:
    "We couldn't decode this file as UTF-8 text for preview.",
  previewDirectoryLabel: "Folder",
  previewEmptyLabel: "Select a file or folder to view details",
  previewFileTooLarge:
    "This file is larger than {{maxSize}}, so inline preview is disabled.",
  previewLoadingLabel: "Loading preview...",
  previewTooLarge:
    "This text file is larger than {{maxSize}}, so inline preview is disabled.",
  previewUnavailableDownloadBody:
    "Download {{name}} to open it in another environment.",
  previewUnavailableOpenBody: "Open {{name}} in your local app instead.",
  previewUnavailableTitle: "Can't preview this file",
  previewUnsupported: "Inline preview isn't available for this file type yet.",
  revealFailedTitle: "Could not reveal in file manager",
  renameActionLabel: "Rename",
  renameLabel: "Rename",
  renamePlaceholder: "New name",
  refreshLabel: "Refresh",
  resizeLocationsSidebar: "Resize locations sidebar",
  resizePreviewPanel: "Resize file details panel",
  retryLabel: "Retry",
  searchPlaceholder: "Search files",
  searchResultsLabel: "Search results",
  sizeLabel: "Size",
  unsupportedViewBody:
    "Opening {{name}} from the file manager is not supported in this desktop build yet.",
  unsupportedViewTitle: "Open not available yet",
  layoutIconViewLabel: "Icon view",
  layoutIconViewTooltipLabel: "Icon mode",
  layoutListViewLabel: "List view",
  layoutListViewTooltipLabel: "List mode"
} as const satisfies I18nDictionary;

const workspaceFileManagerZhCN = {
  backLabel: "后退",
  arrangeApplicationLabel: "应用程序",
  arrangeCreatedLabel: "创建日期",
  arrangeDateAddedLabel: "添加日期",
  arrangeKindLabel: "种类",
  arrangeLastOpenedLabel: "上次打开日期",
  arrangeMenuLabel: "排列方式",
  arrangeNoneLabel: "无",
  breadcrumbRootLabel: "工作区",
  cancelLabel: "取消",
  closeLabel: "关闭",
  copyLabel: "复制",
  copyPathLabel: "复制路径",
  copyPathSuccessTitle: "复制成功",
  copySuccessTitle: "已复制到剪贴板",
  createActionLabel: "创建",
  createDirectoryLabel: "新建文件夹",
  createDirectoryPlaceholder: "文件夹名称",
  createFileLabel: "新建文件",
  createFilePlaceholder: "文件名称",
  createNameInvalid: "请输入有效名称，且不要包含路径分隔符",
  createNameRequired: "请输入名称后再继续",
  createNameTooLong: "名称不能超过 255 个 UTF-8 字节",
  clearSearchLabel: "清空搜索",
  deleteConfirmDescription: "要从这个工作区删除 {{name}} 吗？",
  deleteLabel: "删除",
  deletingLabel: "删除中...",
  downloadFailedTitle: "下载失败",
  downloadLabel: "下载",
  emptyDirectory: "这个文件夹里没有可见文件",
  collapseFolderLabel: "收起文件夹",
  expandFolderLabel: "展开文件夹",
  forwardLabel: "前进",
  loading: "加载中",
  modifiedLabel: "修改时间",
  nameLabel: "名称",
  noSearchResults: "没有匹配的文件",
  openFailedTitle: "打开失败",
  openLabel: "打开",
  openInAppBrowserLabel: "Tutti 内置的浏览器",
  openInDefaultBrowserLabel: "默认浏览器",
  openInFileViewerLabel: "文件查看器",
  openWithLabel: "打开方式",
  openWithLoadingLabel: "正在加载应用...",
  openWithOtherLabel: "其他...",
  openWithOtherPickerPrompt: "选择用来打开此文件的应用程序：",
  revealInFileExplorerLabel: "在文件资源管理器中显示",
  revealInFileManagerLabel: "在文件管理器中显示",
  revealInFinderLabel: "在 Finder 中显示",
  shareLabel: "分享",
  unknownErrorMessage: "出了点问题，请稍后再试。",
  previewActionsLabel: "文件操作",
  previewBinary: "这个文件更像二进制内容，当前先保持只读占位。",
  previewDecodeFailed: "暂时无法按 UTF-8 文本解码这个文件。",
  previewDirectoryLabel: "文件夹",
  previewEmptyLabel: "选择文件或文件夹查看详情",
  previewFileTooLarge: "这个文件超过了 {{maxSize}}，暂时不做内联预览。",
  previewLoadingLabel: "正在加载预览...",
  previewTooLarge: "这个文本文件超过了 {{maxSize}}，暂时不做内联预览。",
  previewUnavailableDownloadBody: "下载 {{name}} 后再在其他环境中打开。",
  previewUnavailableOpenBody: "改为在本地应用中打开 {{name}}。",
  previewUnavailableTitle: "这个文件暂时无法预览",
  previewUnsupported: "这种文件类型暂时还不支持内联预览。",
  revealFailedTitle: "无法在文件管理器中显示",
  renameActionLabel: "重命名",
  renameLabel: "重命名",
  renamePlaceholder: "新名称",
  refreshLabel: "刷新",
  resizeLocationsSidebar: "调整位置侧栏宽度",
  resizePreviewPanel: "调整文件详情面板宽度",
  retryLabel: "重试",
  searchPlaceholder: "搜索文件",
  searchResultsLabel: "搜索结果",
  sizeLabel: "大小",
  unsupportedViewBody:
    "这个桌面版本暂时还不支持直接从文件管理器打开 {{name}}。",
  unsupportedViewTitle: "暂不支持打开",
  layoutIconViewLabel: "图标",
  layoutIconViewTooltipLabel: "图标模式",
  layoutListViewLabel: "列表",
  layoutListViewTooltipLabel: "列表模式"
} as const satisfies I18nDictionary;

export type WorkspaceFileManagerI18nKey = keyof typeof workspaceFileManagerEn;

export type WorkspaceFileManagerI18nRuntime =
  I18nRuntime<WorkspaceFileManagerI18nKey>;

const workspaceFileManagerDefaults: Record<
  WorkspaceFileManagerI18nLocale,
  I18nDictionary
> = {
  en: workspaceFileManagerEn,
  "zh-CN": workspaceFileManagerZhCN
};

export const workspaceFileManagerI18nResources: Record<
  WorkspaceFileManagerI18nLocale,
  I18nDictionary
> = {
  en: {
    [workspaceFileManagerI18nNamespace]: workspaceFileManagerDefaults.en
  },
  "zh-CN": {
    [workspaceFileManagerI18nNamespace]: workspaceFileManagerDefaults["zh-CN"]
  }
};

export function createWorkspaceFileManagerI18nRuntime(
  runtime: I18nRuntime<string>
): WorkspaceFileManagerI18nRuntime {
  return createScopedI18nRuntime<WorkspaceFileManagerI18nKey>(
    runtime,
    workspaceFileManagerI18nNamespace
  );
}

export function resolveRevealInFolderLabel(
  copy: WorkspaceFileManagerI18nRuntime,
  platform: string
): string {
  if (platform === "darwin") {
    return copy.t("revealInFinderLabel");
  }
  if (platform === "win32") {
    return copy.t("revealInFileExplorerLabel");
  }
  return copy.t("revealInFileManagerLabel");
}
