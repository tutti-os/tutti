import { useEffect, useState, type RefObject } from "react";
import type {
  AgentRichTextEditorHandle,
  AgentRichTextPastedImage
} from "../agentRichText/AgentRichTextEditor";
import {
  imageFilesFromDataTransfer,
  nonImageFilesFromDataTransfer,
  readAgentRichTextPromptImages,
  systemFileDragInfoFromDataTransfer
} from "../agentRichText/agentRichTextPromptImages";
import { hasWorkspaceFileDropData } from "../../terminalNode/workspaceFileDrop";

interface UseComposerFileDropInput {
  composerRef: RefObject<HTMLFormElement | null>;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
  inputDisabled: boolean;
  promptFilesSupported: boolean;
  promptImagesSupported: boolean;
  addDraftImages: (images: AgentRichTextPastedImage[]) => void;
  applyDroppedFileReferences: (files: readonly File[]) => Promise<void>;
  scheduleComposerFocus: () => void;
  onPromptImagesUnsupported?: () => void;
}

function isPointInsideElement(
  element: HTMLElement,
  clientX: number,
  clientY: number
): boolean {
  const bounds = element.getBoundingClientRect();
  return (
    clientX >= bounds.left &&
    clientX <= bounds.right &&
    clientY >= bounds.top &&
    clientY <= bounds.bottom
  );
}

export function useComposerFileDrop({
  composerRef,
  editorHandleRef,
  inputDisabled,
  promptFilesSupported,
  promptImagesSupported,
  addDraftImages,
  applyDroppedFileReferences,
  scheduleComposerFocus,
  onPromptImagesUnsupported
}: UseComposerFileDropInput) {
  const [fileDropOverlayHost, setFileDropOverlayHost] =
    useState<HTMLElement | null>(null);
  const [fileDropOverlayActive, setFileDropOverlayActive] = useState(false);
  useEffect(() => {
    const composer = composerRef.current;
    const dropTarget = composer?.closest("#agent-gui-detail") ?? composer;
    if (!dropTarget) {
      return undefined;
    }
    let isDisposed = false;
    setFileDropOverlayHost(dropTarget as HTMLElement);

    const isDragEvent = (event: Event): event is DragEvent =>
      "dataTransfer" in event;

    const clearDropOverlay = (): void => {
      if (!isDisposed) {
        setFileDropOverlayActive(false);
      }
    };

    const containsEventTarget = (event: DragEvent): boolean => {
      const target = event.target;
      return target instanceof Node && dropTarget.contains(target);
    };

    const systemFileDrag = (
      event: DragEvent
    ): { hasImageFiles: boolean; hasRegularFiles: boolean } | null => {
      if (
        event.defaultPrevented ||
        inputDisabled ||
        !containsEventTarget(event) ||
        hasWorkspaceFileDropData(event.dataTransfer)
      ) {
        return null;
      }
      const dragInfo = systemFileDragInfoFromDataTransfer(event.dataTransfer);
      const hasRegularFiles = dragInfo.hasRegularFiles && promptFilesSupported;
      if (!dragInfo.hasImageFiles && !hasRegularFiles) {
        return null;
      }
      return { hasImageFiles: dragInfo.hasImageFiles, hasRegularFiles };
    };

    const systemFileDrop = (
      event: DragEvent
    ): { imageFiles: File[]; regularFiles: File[] } | null => {
      if (
        event.defaultPrevented ||
        inputDisabled ||
        !containsEventTarget(event) ||
        hasWorkspaceFileDropData(event.dataTransfer)
      ) {
        return null;
      }
      const imageFiles = imageFilesFromDataTransfer(event.dataTransfer);
      const imageFileSet = new Set(imageFiles);
      const regularFiles = promptFilesSupported
        ? nonImageFilesFromDataTransfer(event.dataTransfer).filter(
            (file) => !imageFileSet.has(file)
          )
        : [];
      if (imageFiles.length === 0 && regularFiles.length === 0) {
        return null;
      }
      return { imageFiles, regularFiles };
    };

    const handleDragOver: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      const drag = systemFileDrag(event);
      if (!drag) {
        return;
      }
      event.preventDefault();
      if (
        !drag.hasRegularFiles &&
        drag.hasImageFiles &&
        !promptImagesSupported
      ) {
        clearDropOverlay();
        return;
      }
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      if (!isDisposed) {
        setFileDropOverlayActive(true);
      }
    };

    const handleDrop: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      const drop = systemFileDrop(event);
      if (!drop) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearDropOverlay();
      if (drop.regularFiles.length > 0) {
        editorHandleRef.current?.focusAtEnd();
        void applyDroppedFileReferences(drop.regularFiles).then(() => {
          if (!isDisposed) {
            scheduleComposerFocus();
          }
        });
      }
      if (drop.imageFiles.length === 0) {
        return;
      }
      if (!promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      void readAgentRichTextPromptImages(drop.imageFiles).then((images) => {
        if (isDisposed || images.length === 0) {
          return;
        }
        addDraftImages(images);
        scheduleComposerFocus();
      });
    };

    // `dragleave` is unreliable across nested children, so mirror the file
    // manager and clear the overlay from a capture-phase document listener
    // whenever the pointer leaves the drop target's bounds.
    const handleDocumentDragOver: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      if (
        isPointInsideElement(
          dropTarget as HTMLElement,
          event.clientX,
          event.clientY
        )
      ) {
        return;
      }
      clearDropOverlay();
    };

    // Once the drag leaves the window entirely, `dragover` stops firing (so the
    // handler above can never fire) and external file drags never dispatch a
    // renderer-side `dragend` — leaving the overlay stuck. A `dragleave` whose
    // pointer sits at/outside the viewport edge (or has no relatedTarget) means
    // the cursor left the window, so clear the overlay then.
    const handleDocumentDragLeave: EventListener = (event): void => {
      if (!isDragEvent(event)) {
        return;
      }
      const leftWindow =
        event.relatedTarget === null ||
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight;
      if (leftWindow) {
        clearDropOverlay();
      }
    };

    dropTarget.addEventListener("dragover", handleDragOver);
    dropTarget.addEventListener("drop", handleDrop);
    document.addEventListener("dragover", handleDocumentDragOver, true);
    document.addEventListener("dragleave", handleDocumentDragLeave, true);
    window.addEventListener("dragend", clearDropOverlay);
    window.addEventListener("drop", clearDropOverlay);
    window.addEventListener("blur", clearDropOverlay);
    return () => {
      isDisposed = true;
      setFileDropOverlayHost(null);
      setFileDropOverlayActive(false);
      dropTarget.removeEventListener("dragover", handleDragOver);
      dropTarget.removeEventListener("drop", handleDrop);
      document.removeEventListener("dragover", handleDocumentDragOver, true);
      document.removeEventListener("dragleave", handleDocumentDragLeave, true);
      window.removeEventListener("dragend", clearDropOverlay);
      window.removeEventListener("drop", clearDropOverlay);
      window.removeEventListener("blur", clearDropOverlay);
    };
  }, [
    addDraftImages,
    applyDroppedFileReferences,
    inputDisabled,
    onPromptImagesUnsupported,
    promptFilesSupported,
    promptImagesSupported,
    scheduleComposerFocus
  ]);

  return { fileDropOverlayActive, fileDropOverlayHost };
}
