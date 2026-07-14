import { flushSync } from "react-dom";
import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import { useOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentComposerDraftLargeText
} from "../model/agentGuiNodeTypes";
import {
  agentComposerDraftImages,
  agentComposerDraftLargeTexts,
  buildAgentComposerDraft,
  MAX_AGENT_COMPOSER_DRAFT_IMAGES,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";
import type {
  AgentRichTextEditorHandle,
  AgentRichTextPastedImage
} from "../agentRichText/AgentRichTextEditor";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import { parseMentionItemFromHref } from "../agentRichText/agentFileMentionExtension";
import type { AgentDroppedFileReferenceResolver } from "../model/agentDroppedFileReferences";
import {
  resolveWorkspaceLinkAction,
  type WorkspaceLinkAction
} from "../../../actions/workspaceLinkActions";
import {
  AGENT_COMPOSER_PASTED_TEXT_FILE_PREFIX,
  agentComposerTextByteLength,
  buildGoalModePrompt,
  goalDraftObjectiveFromPrompt
} from "./composerDraftUtils";
import { reportAgentComposerDiagnostic } from "./agentComposerDiagnostics";

export interface WorkspaceReferencePickResult {
  files: readonly WorkspaceFileReference[];
  mentionItems: readonly AgentContextMentionItem[];
}

function useStableEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

interface UseComposerDraftAttachmentsInput {
  workspaceId: string;
  workspacePath?: string | null;
  draftContent: AgentComposerDraft;
  draftScopeKey: string;
  draftByScopeKeyRef: RefObject<Record<string, AgentComposerDraft>>;
  goalDraftObjective: string | null;
  isGoalModeActive: boolean;
  promptImagesSupported: boolean;
  promptFileUploadSupported: boolean;
  promptFilesSupported: boolean;
  pastedTextStagingSupported: boolean;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
  draftPromptRef: RefObject<string>;
  draftImagesRef: RefObject<AgentComposerDraftImage[]>;
  draftFilesRef: RefObject<AgentComposerDraftFile[]>;
  draftLargeTextsRef: RefObject<AgentComposerDraftLargeText[]>;
  setPaletteDraftPrompt: Dispatch<SetStateAction<string>>;
  setIsPaletteOpen: Dispatch<SetStateAction<boolean>>;
  clearActiveFileMentionTrigger: () => void;
  onDraftContentChange: (
    draft: AgentComposerDraft,
    sourceScopeKey?: string
  ) => void;
  onPromptImagesUnsupported?: () => void;
  onRequestWorkspaceReferences?:
    | ((
        entity?: AgentContextMentionItem | null
      ) => Promise<WorkspaceReferencePickResult>)
    | null;
  resolveDroppedFileReferences?: AgentDroppedFileReferenceResolver | null;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
}

export function useComposerDraftAttachments({
  workspaceId,
  workspacePath,
  draftContent,
  draftScopeKey,
  draftByScopeKeyRef,
  goalDraftObjective,
  isGoalModeActive,
  promptImagesSupported,
  promptFileUploadSupported,
  promptFilesSupported,
  pastedTextStagingSupported,
  editorHandleRef,
  draftPromptRef,
  draftImagesRef,
  draftFilesRef,
  draftLargeTextsRef,
  setPaletteDraftPrompt,
  setIsPaletteOpen,
  clearActiveFileMentionTrigger,
  onDraftContentChange,
  onPromptImagesUnsupported,
  onRequestWorkspaceReferences,
  resolveDroppedFileReferences,
  onLinkAction
}: UseComposerDraftAttachmentsInput) {
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const publishScopedDraft = useStableEventCallback(
    (sourceScopeKey: string, nextDraft: AgentComposerDraft): void => {
      draftByScopeKeyRef.current[sourceScopeKey] = nextDraft;
      if (sourceScopeKey === draftScopeKey) {
        onDraftContentChange(nextDraft);
      } else {
        onDraftContentChange(nextDraft, sourceScopeKey);
      }
    }
  );
  const updateScopedDraft = useStableEventCallback(
    (
      sourceScopeKey: string,
      update: (current: AgentComposerDraft) => AgentComposerDraft
    ): AgentComposerDraft | null => {
      const current = draftByScopeKeyRef.current[sourceScopeKey];
      if (!current) return null;
      const next = update(current);
      publishScopedDraft(sourceScopeKey, next);
      return next;
    }
  );
  const openReferencesForEntityRef = useRef<
    ((entity: AgentContextMentionItem) => void) | null
  >(null);
  const handleDraftChange = useStableEventCallback(
    (nextDraft: string): void => {
      if (isGoalModeActive) {
        const nextGoalPrompt = buildGoalModePrompt(nextDraft);
        draftPromptRef.current = nextGoalPrompt;
        setPaletteDraftPrompt(nextDraft);
        setIsPaletteOpen(true);
        publishScopedDraft(
          draftScopeKey,
          updateAgentComposerDraft(draftContent, { prompt: nextGoalPrompt })
        );
        return;
      }
      const nextGoalObjective = goalDraftObjectiveFromPrompt(nextDraft);
      if (nextGoalObjective !== null) {
        const nextGoalPrompt = buildGoalModePrompt(nextGoalObjective);
        draftPromptRef.current = nextGoalPrompt;
        setPaletteDraftPrompt(nextGoalObjective);
        setIsPaletteOpen(true);
        publishScopedDraft(
          draftScopeKey,
          updateAgentComposerDraft(draftContent, { prompt: nextGoalPrompt })
        );
        return;
      }
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      setIsPaletteOpen(true);
      publishScopedDraft(
        draftScopeKey,
        updateAgentComposerDraft(draftContent, { prompt: nextDraft })
      );
    }
  );

  const clearGoalModeBadge = useCallback((): void => {
    if (!isGoalModeActive) {
      return;
    }
    const nextPrompt = goalDraftObjective ?? "";
    draftPromptRef.current = nextPrompt;
    setPaletteDraftPrompt(nextPrompt);
    publishScopedDraft(
      draftScopeKey,
      updateAgentComposerDraft(draftContent, { prompt: nextPrompt })
    );
  }, [
    draftContent,
    draftScopeKey,
    goalDraftObjective,
    isGoalModeActive,
    publishScopedDraft
  ]);

  const addDraftImages = useCallback(
    (images: AgentRichTextPastedImage[]): void => {
      if (images.length === 0) {
        return;
      }
      if (!promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      const currentDraftImages = draftImagesRef.current;
      const remainingSlots = Math.max(
        0,
        MAX_AGENT_COMPOSER_DRAFT_IMAGES - currentDraftImages.length
      );
      if (remainingSlots === 0) {
        return;
      }
      const uploadPromptContent =
        agentActivityRuntime?.uploadPromptContent &&
        (agentActivityRuntime.promptContentUploadSupport?.image ?? true)
          ? agentActivityRuntime.uploadPromptContent
          : undefined;
      reportAgentComposerDiagnostic(agentActivityRuntime, {
        details: {
          imageCount: Math.min(images.length, remainingSlots),
          promptImagesSupported,
          runtimeAvailable: Boolean(agentActivityRuntime),
          uploadFunctionAvailable: Boolean(uploadPromptContent),
          uploadSupportDeclared:
            agentActivityRuntime?.promptContentUploadSupport?.image ?? null
        },
        event: "agent.gui.composer.image_upload.requested",
        level: "info",
        source: "agent-gui",
        workspaceId
      });
      const nextImages = images.slice(0, remainingSlots).map((image) => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        name: image.name,
        mimeType: image.mimeType,
        data: image.data,
        previewUrl: `data:${image.mimeType};base64,${image.data}`,
        uploading: Boolean(uploadPromptContent)
      }));
      const nextDraftImages = [...currentDraftImages, ...nextImages];
      draftImagesRef.current = nextDraftImages;
      publishScopedDraft(
        draftScopeKey,
        buildAgentComposerDraft({
          prompt: draftPromptRef.current,
          images: nextDraftImages,
          files: draftFilesRef.current,
          largeTexts: draftLargeTextsRef.current
        })
      );
      if (!uploadPromptContent) {
        return;
      }
      for (const draftImage of nextImages) {
        void uploadPromptContent({
          workspaceId,
          content: [
            {
              type: "image",
              mimeType: draftImage.mimeType,
              data: draftImage.data,
              name: draftImage.name
            }
          ]
        })
          .then((result) => {
            const uploadedImage = result.content.find(
              (block) => block.type === "image"
            );
            const uploadedUrl = uploadedImage?.url?.trim();
            reportAgentComposerDiagnostic(agentActivityRuntime, {
              details: {
                foundImageBlock: Boolean(uploadedImage),
                hasAttachmentId: Boolean(uploadedImage?.attachmentId?.trim()),
                hasData: Boolean(uploadedImage?.data?.trim()),
                hasPath: Boolean(uploadedImage?.path?.trim()),
                hasUrl: Boolean(uploadedUrl),
                imageId: draftImage.id
              },
              event: "agent.gui.composer.image_upload.resolved",
              level: "info",
              source: "agent-gui",
              workspaceId
            });
            if (
              !uploadedImage ||
              (!uploadedUrl &&
                !uploadedImage.attachmentId &&
                !uploadedImage.path &&
                !uploadedImage.data)
            ) {
              throw new Error(
                "Prompt image upload completed without usable image reference."
              );
            }
            updateScopedDraft(draftScopeKey, (currentDraft) =>
              updateAgentComposerDraft(currentDraft, {
                images: agentComposerDraftImages(currentDraft).map((image) =>
                  image.id === draftImage.id
                    ? {
                        id: image.id,
                        name: image.name,
                        mimeType: image.mimeType,
                        ...(uploadedImage.attachmentId
                          ? { attachmentId: uploadedImage.attachmentId }
                          : {}),
                        ...(uploadedUrl
                          ? { url: uploadedUrl }
                          : uploadedImage.data
                            ? { data: uploadedImage.data }
                            : {}),
                        ...(uploadedImage.path
                          ? { path: uploadedImage.path }
                          : {}),
                        previewUrl: image.previewUrl,
                        uploading: false
                      }
                    : image
                )
              })
            );
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            reportAgentComposerDiagnostic(agentActivityRuntime, {
              details: {
                error: message.slice(0, 500),
                imageId: draftImage.id
              },
              event: "agent.gui.composer.image_upload.failed",
              level: "warn",
              source: "agent-gui",
              workspaceId
            });
            updateScopedDraft(draftScopeKey, (currentDraft) =>
              updateAgentComposerDraft(currentDraft, {
                images: agentComposerDraftImages(currentDraft).map((image) =>
                  image.id === draftImage.id
                    ? {
                        ...image,
                        uploading: false,
                        uploadError: message
                      }
                    : image
                )
              })
            );
          });
      }
    },
    [
      agentActivityRuntime,
      draftScopeKey,
      onPromptImagesUnsupported,
      publishScopedDraft,
      promptImagesSupported,
      updateScopedDraft,
      workspaceId
    ]
  );

  const removeDraftImage = useCallback(
    (id: string): void => {
      const nextDraftImages = draftImagesRef.current.filter(
        (image) => image.id !== id
      );
      draftImagesRef.current = nextDraftImages;
      publishScopedDraft(
        draftScopeKey,
        buildAgentComposerDraft({
          prompt: draftPromptRef.current,
          images: nextDraftImages,
          files: draftFilesRef.current,
          largeTexts: draftLargeTextsRef.current
        })
      );
    },
    [draftScopeKey, publishScopedDraft]
  );

  const removeDraftFile = useCallback(
    (id: string): void => {
      const nextDraftFiles = draftFilesRef.current.filter(
        (file) => file.id !== id
      );
      draftFilesRef.current = nextDraftFiles;
      publishScopedDraft(
        draftScopeKey,
        buildAgentComposerDraft({
          prompt: draftPromptRef.current,
          images: draftImagesRef.current,
          files: nextDraftFiles,
          largeTexts: draftLargeTextsRef.current
        })
      );
    },
    [draftScopeKey, publishScopedDraft]
  );

  const removeDraftLargeText = useCallback(
    (id: string): void => {
      const nextDraftLargeTexts = draftLargeTextsRef.current.filter(
        (item) => item.id !== id
      );
      draftLargeTextsRef.current = nextDraftLargeTexts;
      publishScopedDraft(
        draftScopeKey,
        buildAgentComposerDraft({
          prompt: draftPromptRef.current,
          images: draftImagesRef.current,
          files: draftFilesRef.current,
          largeTexts: nextDraftLargeTexts
        })
      );
    },
    [draftScopeKey, publishScopedDraft]
  );

  // "Show in text field": dissolve a pasted-text chip back into the composer as
  // inline prompt text and drop the attachment. Only possible while the full
  // body is still in memory (a fresh paste); a chip restored from a queued
  // message carries only the landed path, so expansion is unavailable there.
  const expandDraftLargeTextToPrompt = useCallback(
    (id: string): void => {
      const item = draftLargeTextsRef.current.find((entry) => entry.id === id);
      if (!item || !item.text.trim()) {
        return;
      }
      const currentPrompt = draftPromptRef.current;
      const nextPrompt = currentPrompt.trim()
        ? `${currentPrompt}\n${item.text}`
        : item.text;
      const nextDraftLargeTexts = draftLargeTextsRef.current.filter(
        (entry) => entry.id !== id
      );
      draftPromptRef.current = nextPrompt;
      draftLargeTextsRef.current = nextDraftLargeTexts;
      setPaletteDraftPrompt(nextPrompt);
      publishScopedDraft(
        draftScopeKey,
        buildAgentComposerDraft({
          prompt: nextPrompt,
          images: draftImagesRef.current,
          files: draftFilesRef.current,
          largeTexts: nextDraftLargeTexts
        })
      );
      window.requestAnimationFrame(() => {
        editorHandleRef.current?.focusAtEnd();
      });
    },
    [draftScopeKey, publishScopedDraft]
  );

  const handlePastedLargeText = useCallback(
    (text: string): void => {
      const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!normalizedText.trim()) {
        return;
      }
      const stagePastedText = pastedTextStagingSupported
        ? agentActivityRuntime?.stagePastedText
        : undefined;
      const id = crypto.randomUUID();
      const name = `${AGENT_COMPOSER_PASTED_TEXT_FILE_PREFIX}.txt`;
      const sizeBytes = agentComposerTextByteLength(normalizedText);
      const nextDraftLargeTexts = [
        ...draftLargeTextsRef.current,
        {
          id,
          name,
          text: normalizedText,
          sizeBytes,
          uploading: Boolean(stagePastedText),
          ...(!stagePastedText
            ? {
                uploadError:
                  "Pasted text staging is not supported by this agent runtime."
              }
            : {})
        }
      ];
      draftLargeTextsRef.current = nextDraftLargeTexts;
      publishScopedDraft(
        draftScopeKey,
        buildAgentComposerDraft({
          prompt: draftPromptRef.current,
          images: draftImagesRef.current,
          files: draftFilesRef.current,
          largeTexts: nextDraftLargeTexts
        })
      );
      if (!stagePastedText) {
        return;
      }
      void stagePastedText({
        workspaceId,
        text: normalizedText,
        name
      })
        .then((result) => {
          const uploadedPath = result.path.trim();
          if (!uploadedPath) {
            throw new Error("Pasted text staging completed without path.");
          }
          updateScopedDraft(draftScopeKey, (currentDraft) =>
            updateAgentComposerDraft(currentDraft, {
              largeTexts: agentComposerDraftLargeTexts(currentDraft).map(
                (item) =>
                  item.id === id
                    ? {
                        ...item,
                        path: uploadedPath,
                        name: result.name || item.name,
                        sizeBytes: result.sizeBytes,
                        uploading: false
                      }
                    : item
              )
            })
          );
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          updateScopedDraft(draftScopeKey, (currentDraft) =>
            updateAgentComposerDraft(currentDraft, {
              largeTexts: agentComposerDraftLargeTexts(currentDraft).map(
                (item) =>
                  item.id === id
                    ? { ...item, uploading: false, uploadError: message }
                    : item
              )
            })
          );
        });
    },
    [
      agentActivityRuntime,
      draftScopeKey,
      pastedTextStagingSupported,
      publishScopedDraft,
      updateScopedDraft,
      workspaceId
    ]
  );

  const applyReferencePickResult = useCallback(
    async (result: WorkspaceReferencePickResult) => {
      if (result.files.length > 0) {
        const uploadPromptContent = promptFileUploadSupported
          ? agentActivityRuntime?.uploadPromptContent
          : undefined;
        const uploadedFiles = await Promise.all(
          result.files.map(async (file) => {
            const hostPath = file.hostPath?.trim() ?? "";
            if (!hostPath) {
              return file;
            }
            if (!uploadPromptContent) {
              throw new Error(
                "Prompt file uploads are not supported by this agent runtime."
              );
            }
            const uploaded = await uploadPromptContent({
              workspaceId,
              content: [
                {
                  type: "file",
                  hostPath,
                  name: file.displayName,
                  kind: "file"
                }
              ]
            });
            const uploadedFile = uploaded.content.find(
              (block) => block.type === "file"
            );
            const uploadedPath = uploadedFile?.path?.trim() ?? "";
            if (!uploadedPath) {
              throw new Error("Prompt file upload completed without path.");
            }
            return {
              ...file,
              path: uploadedPath,
              ...(uploadedFile?.name
                ? { displayName: uploadedFile.name }
                : file.displayName
                  ? { displayName: file.displayName }
                  : {}),
              ...(uploadedFile?.sizeBytes
                ? { sizeBytes: uploadedFile.sizeBytes }
                : {})
            };
          })
        );
        editorHandleRef.current?.insertWorkspaceReferences(uploadedFiles);
      }
      if (result.mentionItems.length > 0) {
        editorHandleRef.current?.insertMentionItems(result.mentionItems);
      }
    },
    [agentActivityRuntime, promptFileUploadSupported, workspaceId]
  );

  const handleWorkspaceReferencePicker = useCallback(async () => {
    if (!onRequestWorkspaceReferences) {
      return;
    }
    await applyReferencePickResult(await onRequestWorkspaceReferences());
  }, [applyReferencePickResult, onRequestWorkspaceReferences]);

  const applyDroppedFileReferences = useCallback(
    async (files: readonly File[]) => {
      if (
        !promptFilesSupported ||
        !resolveDroppedFileReferences ||
        files.length === 0
      ) {
        return;
      }
      const references = await resolveDroppedFileReferences(files);
      if (references.length === 0) {
        return;
      }
      await applyReferencePickResult({ files: references, mentionItems: [] });
    },
    [
      applyReferencePickResult,
      promptFilesSupported,
      resolveDroppedFileReferences
    ]
  );

  // @ 面板里点任务/应用行的「查看产物」入口:保留面板,打开引用 picker 并定位到该实体;
  // 选中的文件仍按常规插入,但不会把该任务/应用本身作为 mention 插入。
  const handleOpenReferencesForEntity = useCallback(
    (entity: AgentContextMentionItem): void => {
      if (!onRequestWorkspaceReferences) {
        return;
      }
      void onRequestWorkspaceReferences(entity).then((result) => {
        if (result.files.length > 0 || result.mentionItems.length > 0) {
          flushSync(clearActiveFileMentionTrigger);
        }
        return applyReferencePickResult(result);
      });
    },
    [
      clearActiveFileMentionTrigger,
      applyReferencePickResult,
      onRequestWorkspaceReferences
    ]
  );
  // 让 handleLinkClick(定义在前)能转发到此处:点击 workspace-reference chip 即定位打开 picker。
  openReferencesForEntityRef.current = handleOpenReferencesForEntity;

  openReferencesForEntityRef.current = handleOpenReferencesForEntity;

  const handleLinkClick = useCallback(
    (href: string): void => {
      const item = parseMentionItemFromHref({ name: "", href });
      if (item?.kind === "workspace-reference") {
        openReferencesForEntityRef.current?.(item);
        return;
      }
      const action = resolveWorkspaceLinkAction({
        href,
        workspaceRoot: workspacePath,
        source: "agent-markdown"
      });
      if (action) {
        onLinkAction?.(action);
      }
    },
    [onLinkAction, workspacePath]
  );

  return {
    addDraftImages,
    applyDroppedFileReferences,
    clearGoalModeBadge,
    expandDraftLargeTextToPrompt,
    handleDraftChange,
    handleLinkClick,
    handleOpenReferencesForEntity,
    handlePastedLargeText,
    handleWorkspaceReferencePicker,
    removeDraftFile,
    removeDraftImage,
    removeDraftLargeText
  };
}
