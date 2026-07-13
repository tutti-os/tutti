import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ReferenceLocateTarget,
  ReferenceNode,
  WorkspaceFileReference
} from "@tutti-os/workspace-file-reference/contracts";
import type { ReferenceGroupedSelection } from "@tutti-os/workspace-file-reference/ui";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import type { WorkspaceReferencePickResult } from "../AgentComposer";
import type {
  AgentContextMentionItem,
  AgentMentionWorkspaceReferenceItem
} from "../agentRichText/agentFileMentionExtension";
import type { AgentGUINodeViewProps } from "./AgentGUINodeView.types";

interface Input {
  onWorkspaceFileReferencesAdded: AgentGUINodeViewProps["onWorkspaceFileReferencesAdded"];
  previewMode: boolean;
  referenceSourceAggregator: AgentGUINodeViewProps["referenceSourceAggregator"];
  resolveMentionReferenceTarget: AgentGUINodeViewProps["resolveMentionReferenceTarget"];
  resolveWorkspaceReferenceInitialTarget: AgentGUINodeViewProps["resolveWorkspaceReferenceInitialTarget"];
  viewModel: AgentGUINodeViewProps["viewModel"];
  workspaceFileReferenceAdapter: AgentGUINodeViewProps["workspaceFileReferenceAdapter"];
  workspaceFileReferenceCopy: AgentGUINodeViewProps["workspaceFileReferenceCopy"];
}

export function useAgentGUIWorkspaceReferencePicker(input: Input) {
  const {
    onWorkspaceFileReferencesAdded,
    previewMode,
    referenceSourceAggregator,
    resolveMentionReferenceTarget,
    resolveWorkspaceReferenceInitialTarget,
    viewModel,
    workspaceFileReferenceAdapter,
    workspaceFileReferenceCopy
  } = input;
  const [workspaceReferencePickerOpen, setWorkspaceReferencePickerOpen] =
    useState(false);
  // 打开引用 picker 时的定位目标(点任务/应用行的产物图标时设置;「+」按钮则为 null)。
  const [workspaceReferencePickerTarget, setWorkspaceReferencePickerTarget] =
    useState<ReferenceLocateTarget | null>(null);
  const workspaceReferencePickerResolverRef = useRef<
    ((result: WorkspaceReferencePickResult) => void) | null
  >(null);
  const emptyReferencePickResult: WorkspaceReferencePickResult = useMemo(
    () => ({ files: [], mentionItems: [] }),
    []
  );
  const hostLocalFileSourceId = "host-local-file";
  const isWorkspaceReferencePickerNodeSelectable = useCallback(
    (node: ReferenceNode) =>
      node.ref.sourceId !== hostLocalFileSourceId || node.kind === "file",
    [hostLocalFileSourceId]
  );
  const requestWorkspaceReferences = useCallback(
    async (
      entity?: AgentContextMentionItem | null
    ): Promise<WorkspaceReferencePickResult> => {
      if (previewMode) {
        return emptyReferencePickResult;
      }
      if (!workspaceFileReferenceAdapter && !referenceSourceAggregator) {
        return emptyReferencePickResult;
      }
      // 仅多源 picker(referenceSourceAggregator)支持定位;本地 picker 不支持。
      const target =
        entity && referenceSourceAggregator
          ? (resolveMentionReferenceTarget?.(entity) ?? null)
          : referenceSourceAggregator
            ? (resolveWorkspaceReferenceInitialTarget?.({
                activeConversation: viewModel.rail.activeConversation,
                composerSelectedProjectPath:
                  viewModel.composer.composerSettings.selectedProjectPath ??
                  null,
                userProjects: viewModel.rail.userProjects
              }) ?? null)
            : null;
      setWorkspaceReferencePickerTarget(target);
      setWorkspaceReferencePickerOpen(true);
      return await new Promise<WorkspaceReferencePickResult>((resolve) => {
        workspaceReferencePickerResolverRef.current = resolve;
      });
    },
    [
      emptyReferencePickResult,
      previewMode,
      referenceSourceAggregator,
      resolveMentionReferenceTarget,
      resolveWorkspaceReferenceInitialTarget,
      viewModel.rail.activeConversation,
      viewModel.composer.composerSettings.selectedProjectPath,
      viewModel.rail.userProjects,
      workspaceFileReferenceAdapter,
      workspaceFileReferenceCopy
    ]
  );
  const closeWorkspaceReferencePicker = useCallback(() => {
    workspaceReferencePickerResolverRef.current?.(emptyReferencePickResult);
    workspaceReferencePickerResolverRef.current = null;
    setWorkspaceReferencePickerOpen(false);
    setWorkspaceReferencePickerTarget(null);
  }, [emptyReferencePickResult]);
  const settleReferencePicker = useCallback(
    (
      result: WorkspaceReferencePickResult,
      addedFiles: WorkspaceFileReference[]
    ) => {
      workspaceReferencePickerResolverRef.current?.(result);
      workspaceReferencePickerResolverRef.current = null;
      setWorkspaceReferencePickerOpen(false);
      setWorkspaceReferencePickerTarget(null);
      if (addedFiles.length > 0) {
        void onWorkspaceFileReferencesAdded?.(addedFiles);
      }
    },
    [onWorkspaceFileReferencesAdded]
  );
  const confirmWorkspaceReferencePicker = useCallback(
    (refs: WorkspaceFileReference[]) => {
      settleReferencePicker({ files: refs, mentionItems: [] }, refs);
    },
    [settleReferencePicker]
  );
  // 「文件夹=一个 reference 节点」确认:navigable 源文件夹折叠成 workspace-reference
  // mention item(只携带可解析句柄 source+id+groupId,不展开文件);松散文件仍按 file
  // mention 插入。agent 收到 `mention://workspace-reference/...` 后经 skill+CLI 按需解析。
  const confirmWorkspaceReferenceBundles = useCallback(
    (result: ReferenceGroupedSelection) => {
      const workspaceRefs = result.files.filter(
        (ref) => ref.sourceId !== hostLocalFileSourceId
      );
      const mentionItems: AgentMentionWorkspaceReferenceItem[] = result.bundles
        .filter((bundle) => bundle.handle != null)
        .map((bundle) => {
          const handle = bundle.handle!;
          const bundleIconUrl = bundle.iconUrl ?? undefined;
          return {
            kind: "workspace-reference",
            href: createRichTextMentionHref({
              providerId: "workspace-reference",
              entityId: handle.id,
              label: bundle.displayName,
              scope: {
                workspaceId: viewModel.shell.workspaceId,
                source: handle.source,
                ...(handle.groupId?.trim()
                  ? { groupId: handle.groupId.trim() }
                  : {}),
                ...(bundle.fileCount > 0
                  ? { count: String(bundle.fileCount) }
                  : {})
              }
            }),
            workspaceId: viewModel.shell.workspaceId,
            targetId: handle.id,
            source: handle.source,
            ...(handle.groupId ? { groupId: handle.groupId } : {}),
            name: bundle.displayName,
            iconUrl: bundleIconUrl,
            fileCount: bundle.fileCount
          };
        });
      // bundle 不再展开文件,仅松散文件计入「最近引用」跟踪。
      settleReferencePicker(
        { files: result.files, mentionItems },
        workspaceRefs
      );
    },
    [hostLocalFileSourceId, settleReferencePicker]
  );

  return {
    closeWorkspaceReferencePicker,
    confirmWorkspaceReferenceBundles,
    confirmWorkspaceReferencePicker,
    isWorkspaceReferencePickerNodeSelectable,
    requestWorkspaceReferences,
    workspaceReferencePickerOpen,
    workspaceReferencePickerTarget
  };
}
