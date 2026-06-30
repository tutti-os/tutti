export {
  dispatchIssueManagerTaskListCollapsed,
  dispatchIssueManagerIssueCreateRequest,
  dispatchIssueManagerTopicCreate,
  dispatchIssueManagerTopicDelete,
  dispatchIssueManagerTopicHeaderState,
  dispatchIssueManagerTopicSelection,
  dispatchIssueManagerTopicUpdate,
  resolveIssueManagerSelectedIssue,
  resolveIssueManagerSelectedTask,
  useIssueManagerNodeHeaderView,
  useIssueManagerIssueCreateRequestSync,
  useIssueManagerTopicHeaderCommandSync,
  useIssueManagerTopicHeaderStateSync,
  useIssueManagerTaskListCollapsedSync
} from "./internal/shell/IssueManagerNodeState.ts";
export {
  createReferenceDirectoryStateFromSnapshot,
  collectVisibleTreeEntries,
  issueManagerReferenceDefaultExpandedDepth,
  mergeExpandedFolderPaths,
  mergePrefetchedDirectoryState,
  normalizeDirectoryPath,
  prefetchReferenceTree,
  type IssueManagerReferenceDirectoryState
} from "./internal/reference/IssueManagerReferencePickerState.ts";
export {
  useIssueManagerController,
  type IssueManagerController,
  type IssueManagerRichTextSurface
} from "./internal/controller/useIssueManagerController.ts";
export {
  useIssueManagerNodeView,
  type IssueManagerNodeView,
  type IssueManagerNodeViewController,
  type UseIssueManagerNodeViewInput
} from "./internal/shell/useIssueManagerNodeView.ts";
export {
  useWorkspaceFileReferencePickerView as useIssueManagerReferencePickerView,
  type UseWorkspaceFileReferencePickerViewInput as UseIssueManagerReferencePickerViewInput,
  type WorkspaceFileReferencePreviewState as IssueManagerReferencePreviewState
} from "@tutti-os/workspace-file-reference/react";
