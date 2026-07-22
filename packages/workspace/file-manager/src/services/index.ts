export { createWorkspaceFileManagerService } from "./createWorkspaceFileManagerService.ts";
export {
  createWorkspaceFileManagerI18nRuntime,
  resolveRevealInFolderLabel,
  workspaceFileManagerI18nNamespace,
  workspaceFileManagerI18nResources,
  type WorkspaceFileManagerI18nKey,
  type WorkspaceFileManagerI18nRuntime
} from "../i18n/workspaceFileManagerI18n.ts";
export type {
  WorkspaceFileManagerService,
  WorkspaceFileManagerSession
} from "./workspaceFileManagerService.interface.ts";
export type {
  WorkspaceFileManagerFileActivationRequest,
  WorkspaceFileManagerHostActionMessage,
  WorkspaceFileManagerHostActionMessageStatus,
  WorkspaceFileManagerHostActionResult,
  WorkspaceFileManagerHostExportResult,
  WorkspaceFileManagerHostFallbackAction,
  WorkspaceFileManagerHostFallbackActionKind,
  WorkspaceFileManagerHostFileActivationResult,
  WorkspaceFileManagerHostImportConflict,
  WorkspaceFileManagerHostImportResult
} from "./workspaceFileManagerHostTypes.ts";
export type {
  CreateWorkspaceFileManagerSessionInput,
  WorkspaceFileManagerHost,
  WorkspaceFileManagerMutationErrorMessage
} from "./workspaceFileManagerHost.interface.ts";
export {
  resolveWorkspaceFileOpenWithCacheKey,
  WorkspaceFileOpenWithApplicationsCache
} from "./internal/model/openWithApplicationsCache.ts";
export {
  isWorkspaceApplicationBundle,
  resolveWorkspaceFileDefaultApplicationIconExtension,
  resolveWorkspaceFileEntryIconCacheKey,
  shouldResolveWorkspaceFileEntryIcon,
  shouldUseWorkspaceFileArchiveIcon,
  shouldUseWorkspaceFileExtensionDocumentIcon
} from "./workspaceFileEntryIconPolicy.ts";
export {
  findWorkspaceFileLocationById,
  flattenWorkspaceFileLocations,
  isWorkspaceFileExternalLocation,
  isWorkspaceFileRecentLocation,
  resolveWorkspaceFileLocationDefaultId
} from "./workspaceFileManagerLocations.ts";
export { workspaceFileName } from "./internal/model/paths.ts";
export {
  type WorkspaceFileActivationTarget,
  type WorkspaceFileDirectoryListing,
  type WorkspaceFileEntry,
  type WorkspaceFileEntryKind,
  type WorkspaceFileImportSummary,
  type WorkspaceFileImportSummaryReason,
  type WorkspaceFileImportSummaryReasonCount,
  type WorkspaceFileLocation,
  type WorkspaceFileLocationKind,
  type WorkspaceFileLocationSection,
  type WorkspaceFileDirectoryLocation,
  type WorkspaceFileExternalLocation,
  type WorkspaceFileRecentLocation,
  type WorkspaceFileManagerCapabilities,
  type WorkspaceFileManagerFileDefaultOpener,
  type WorkspaceFileOpenWithApplication,
  type WorkspaceFileManagerPersistedState,
  type WorkspaceFilePreviewKind,
  type WorkspaceFilePreviewState,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileManagerState,
  type WorkspaceFileSearchResult,
  type WorkspaceFileImportConflict
} from "./workspaceFileManagerTypes.ts";
// 排序能力(纯逻辑,供 file-reference picker 复用)。
export {
  sortWorkspaceFileEntriesForArrangeMode,
  type WorkspaceFileManagerArrangeMode
} from "../ui/workspaceFileManagerArrangeMode.ts";
