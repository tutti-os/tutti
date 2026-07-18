import { useCallback, useEffect, type RefObject } from "react";
import type {
  AgentRichTextEditorHandle,
  AgentRichTextPastedImage
} from "../agentRichText/AgentRichTextEditor";
import { useComposerFileDrop } from "./useComposerFileDrop";

interface Input {
  composerControlsHardDisabled: boolean;
  inputDisabled: boolean;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
  composerRef: RefObject<HTMLFormElement | null>;
  wasActiveRef: RefObject<boolean>;
  lastComposerFocusRequestRef: RefObject<number | null>;
  isActive: boolean;
  composerFocusRequestSequence: number | null;
  promptFilesSupported: boolean;
  promptImagesSupported: boolean;
  addDraftImages: (images: AgentRichTextPastedImage[]) => void;
  addDraftFiles: (files: readonly File[]) => void;
  onPromptImagesUnsupported?: () => void;
}

export function useComposerFocusAndDrop(input: Input) {
  const {
    composerControlsHardDisabled,
    inputDisabled,
    editorHandleRef,
    composerRef,
    wasActiveRef,
    lastComposerFocusRequestRef,
    isActive,
    composerFocusRequestSequence,
    promptFilesSupported,
    promptImagesSupported,
    addDraftImages,
    addDraftFiles,
    onPromptImagesUnsupported
  } = input;
  const handleMentionPaletteButton = useCallback((): void => {
    if (composerControlsHardDisabled || inputDisabled) {
      return;
    }
    editorHandleRef.current?.openMentionPalette();
  }, [composerControlsHardDisabled, inputDisabled]);
  const scheduleComposerFocus = useCallback(() => {
    if (inputDisabled) {
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        editorHandleRef.current?.focusAtEnd();
      });
    });
  }, [inputDisabled]);
  const handlePastedImages = useCallback(
    (images: AgentRichTextPastedImage[]): void => {
      addDraftImages(images);
      scheduleComposerFocus();
    },
    [addDraftImages, scheduleComposerFocus]
  );
  const { fileDropOverlayActive, fileDropOverlayHost } = useComposerFileDrop({
    composerRef,
    editorHandleRef,
    inputDisabled,
    promptFilesSupported,
    promptImagesSupported,
    addDraftImages,
    addDraftFiles,
    scheduleComposerFocus,
    onPromptImagesUnsupported
  });
  useEffect(() => {
    if (!isActive) {
      wasActiveRef.current = false;
      return;
    }
    if (!wasActiveRef.current) {
      scheduleComposerFocus();
    }
    wasActiveRef.current = true;
  }, [isActive, scheduleComposerFocus]);
  useEffect(() => {
    if (
      composerFocusRequestSequence === null ||
      composerFocusRequestSequence === lastComposerFocusRequestRef.current
    ) {
      return;
    }
    lastComposerFocusRequestRef.current = composerFocusRequestSequence;
    scheduleComposerFocus();
  }, [composerFocusRequestSequence, scheduleComposerFocus]);

  return {
    fileDropOverlayActive,
    fileDropOverlayHost,
    handleMentionPaletteButton,
    handlePastedImages
  };
}
