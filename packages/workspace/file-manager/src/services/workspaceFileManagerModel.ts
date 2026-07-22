export { resolveWorkspaceFileActivationTarget } from "./internal/model/fileKinds.ts";
export {
  formatWorkspaceFileBytes,
  formatWorkspaceFileModifiedTime,
  splitWorkspaceFileName
} from "./internal/model/formatters.ts";
export {
  buildWorkspaceFileBreadcrumbs,
  filterVisibleWorkspaceEntries,
  isHiddenWorkspaceDirectoryEntry,
  normalizeWorkspaceFilePath,
  sortWorkspaceEntries,
  workspaceFileDirectory,
  workspaceFileName,
  workspaceFilePathHasHiddenSegment
} from "./internal/model/paths.ts";
export { workspaceFileSearchEntryToEntry } from "./internal/model/searchEntries.ts";
export { validateWorkspaceFileEntryName } from "./internal/model/validation.ts";
