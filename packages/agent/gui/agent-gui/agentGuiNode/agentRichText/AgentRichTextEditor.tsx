import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type { Editor } from "@tiptap/core";
import { useEditor } from "@tiptap/react";
import { cn } from "../../../app/renderer/lib/utils";
import { useTranslation } from "../../../i18n/index";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import { createAgentRichTextInputExtensions } from "./agentRichTextExtensions";
import {
  agentRichTextContentToPromptText,
  editorToPromptText,
  plainTextToAgentRichTextInlineContent,
  plainTextToAgentRichTextDoc
} from "./agentRichTextDocument";
import { createAgentFileMentionContent } from "./agentWorkspaceFileReferences";
import { isAgentRichTextImeComposing } from "./agentRichTextIme";
import {
  hasWorkspaceFileDropData,
  readWorkspaceFileDropEntries
} from "../../terminalNode/workspaceFileDrop";
import {
  imageFilesFromDataTransfer,
  nonImageFilesFromDataTransfer,
  readAgentRichTextPromptImages,
  systemFileDragInfoFromDataTransfer
} from "./agentRichTextPromptImages";
import type {
  AgentRichTextContextMenuState,
  AgentRichTextEditorHandle,
  AgentRichTextEditorProps
} from "./AgentRichTextEditor.types";
import {
  buildWorkspaceFileMentionDropContent,
  classifyAgentRichTextTextPaste,
  createAgentRichTextCaretAnchorExtension,
  createAgentRichTextPlaceholderExtension,
  isAgentRichTextLargeTextPaste,
  isPromptVisualLineStart,
  readEditorDomSelectionRange,
  readPlainTextFromClipboard,
  readPromptSelection,
  readPromptTextRange,
  readSelectedPlainText,
  scrollEditorSelectionIntoView,
  writePlainTextToClipboard
} from "./agentRichTextEditorSupport";
export { isAgentRichTextLargeTextPaste } from "./agentRichTextEditorSupport";
import { useAgentRichTextEditorHandle } from "./useAgentRichTextEditorHandle";
import { AgentRichTextEditorSurface } from "./AgentRichTextEditorSurface";
import { handleAgentRichTextKeyDownCapture } from "./agentRichTextKeyboard";
import {
  isAgentRichTextUserContentInsertion,
  markAgentRichTextPointerFocus
} from "./agentRichTextEngagement";

export type {
  AgentRichTextEditorHandle,
  AgentRichTextEditorProps,
  AgentRichTextPastedImage
} from "./AgentRichTextEditor.types";
export const AgentRichTextEditor = forwardRef<
  AgentRichTextEditorHandle,
  AgentRichTextEditorProps
>(function AgentRichTextEditor(
  {
    value,
    disabled,
    placeholder,
    removeMentionLabel,
    className,
    onChange,
    onFocus,
    onUserContentChange,
    onSubmit,
    onSubmitGuidance,
    availableCapabilities = [],
    availableSkills = [],
    submitOnEnter = true,
    enableFileMentionSuggestions = true,
    onKeyDownForPalette,
    onFileMentionSuggestionChange,
    onFileMentionSuggestionKeyDown,
    onLinkClick,
    promptImagesSupported = true,
    onPromptImagesUnsupported,
    onPasteImages,
    onPasteLargeText,
    getReferenceForFile,
    onDropFiles
  },
  ref
): React.JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const lastEmittedPromptRef = useRef<string | null>(value);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  const onFocusRef = useRef(onFocus);
  const onUserContentChangeRef = useRef(onUserContentChange);
  const pendingFocusMethodRef = useRef<"pointer" | "programmatic" | null>(null);
  const onSubmitRef = useRef(onSubmit);
  const onSubmitGuidanceRef = useRef(onSubmitGuidance);
  const onKeyDownForPaletteRef = useRef(onKeyDownForPalette);
  const onFileMentionSuggestionChangeRef = useRef(
    onFileMentionSuggestionChange
  );
  const onFileMentionSuggestionKeyDownRef = useRef(
    onFileMentionSuggestionKeyDown
  );
  const onLinkClickRef = useRef(onLinkClick);
  const onPromptImagesUnsupportedRef = useRef(onPromptImagesUnsupported);
  const onPasteImagesRef = useRef(onPasteImages);
  const onPasteLargeTextRef = useRef(onPasteLargeText);
  const onDropFilesRef = useRef(onDropFiles);
  const promptImagesSupportedRef = useRef(promptImagesSupported);
  const getReferenceForFileRef = useRef(getReferenceForFile);
  const placeholderRef = useRef(placeholder);
  const removeMentionLabelRef = useRef(removeMentionLabel);
  const availableSkillsRef = useRef(availableSkills);
  const availableCapabilitiesRef = useRef(availableCapabilities);
  const suppressPastedAtSuggestionRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const [contextMenu, setContextMenu] =
    useState<AgentRichTextContextMenuState | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const insertPlainText = useCallback((text: string): void => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed || !text) {
      return;
    }
    if (onPasteLargeTextRef.current && isAgentRichTextLargeTextPaste(text)) {
      onPasteLargeTextRef.current(text);
      return;
    }
    suppressPastedAtSuggestionRef.current =
      text.includes("@") && !text.endsWith("@");
    if (suppressPastedAtSuggestionRef.current) {
      releasePastedAtSuggestionSuppression(suppressPastedAtSuggestionRef);
    }
    currentEditor
      .chain()
      .focus()
      .insertContent(
        plainTextToAgentRichTextInlineContent(text, {
          capabilities: availableCapabilitiesRef.current,
          skills: availableSkillsRef.current
        })
      )
      .run();
  }, []);

  const copySelection = useCallback(async (): Promise<void> => {
    const currentEditor = editorRef.current;
    const selectedText =
      contextMenu && contextMenu.hasSelection && currentEditor
        ? readPromptTextRange(
            currentEditor,
            contextMenu.selectionFrom,
            contextMenu.selectionTo
          )
        : currentEditor
          ? readSelectedPlainText(currentEditor)
          : "";
    closeContextMenu();
    if (!currentEditor || currentEditor.isDestroyed) {
      return;
    }
    await writePlainTextToClipboard(selectedText);
  }, [closeContextMenu, contextMenu]);

  const cutSelection = useCallback(async (): Promise<void> => {
    const currentEditor = editorRef.current;
    const selectionFrom = contextMenu?.selectionFrom ?? null;
    const selectionTo = contextMenu?.selectionTo ?? null;
    const selectedText =
      contextMenu && contextMenu.hasSelection && currentEditor
        ? readPromptTextRange(
            currentEditor,
            contextMenu.selectionFrom,
            contextMenu.selectionTo
          )
        : currentEditor
          ? readSelectedPlainText(currentEditor)
          : "";
    closeContextMenu();
    if (!currentEditor || currentEditor.isDestroyed || disabled) {
      return;
    }
    if (!(await writePlainTextToClipboard(selectedText))) {
      return;
    }
    const { from, to } =
      selectionFrom !== null &&
      selectionTo !== null &&
      selectionFrom < selectionTo
        ? { from: selectionFrom, to: selectionTo }
        : currentEditor.state.selection;
    currentEditor.chain().focus().deleteRange({ from, to }).run();
  }, [closeContextMenu, contextMenu, disabled]);

  const pasteClipboardText = useCallback(async (): Promise<void> => {
    closeContextMenu();
    if (disabled) {
      return;
    }
    const text = await readPlainTextFromClipboard();
    if (text) {
      insertPlainText(text);
    }
  }, [closeContextMenu, disabled, insertPlainText]);

  const scheduleSelectionScroll = (targetEditor: Editor): void => {
    if (typeof window.requestAnimationFrame !== "function") {
      scrollEditorSelectionIntoView(targetEditor);
      return;
    }
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const currentEditor = editorRef.current;
      if (
        !currentEditor ||
        currentEditor !== targetEditor ||
        currentEditor.isDestroyed
      ) {
        return;
      }
      scrollEditorSelectionIntoView(currentEditor);
    });
  };

  const extensions = useMemo(
    () => [
      ...createAgentRichTextInputExtensions(
        {
          enableSuggestions: enableFileMentionSuggestions,
          onSuggestionChange: (state) =>
            onFileMentionSuggestionChangeRef.current?.(state),
          onSuggestionKeyDown: (event) =>
            onFileMentionSuggestionKeyDownRef.current?.(event) ?? false,
          removeActionAriaLabel: removeMentionLabelRef.current,
          shouldSuppressSuggestion: () => suppressPastedAtSuggestionRef.current
        },
        { skills: availableSkillsRef.current },
        { capabilities: availableCapabilitiesRef.current }
      ),
      createAgentRichTextCaretAnchorExtension(),
      createAgentRichTextPlaceholderExtension(() => placeholderRef.current)
    ],
    [enableFileMentionSuggestions]
  );

  onChangeRef.current = onChange;
  onFocusRef.current = onFocus;
  onUserContentChangeRef.current = onUserContentChange;
  onSubmitRef.current = onSubmit;
  onSubmitGuidanceRef.current = onSubmitGuidance;
  onKeyDownForPaletteRef.current = onKeyDownForPalette;
  onFileMentionSuggestionChangeRef.current = onFileMentionSuggestionChange;
  onFileMentionSuggestionKeyDownRef.current = onFileMentionSuggestionKeyDown;
  onLinkClickRef.current = onLinkClick;
  onPromptImagesUnsupportedRef.current = onPromptImagesUnsupported;
  onPasteImagesRef.current = onPasteImages;
  onPasteLargeTextRef.current = onPasteLargeText;
  onDropFilesRef.current = onDropFiles;
  promptImagesSupportedRef.current = promptImagesSupported;
  getReferenceForFileRef.current = getReferenceForFile;
  placeholderRef.current = placeholder;
  removeMentionLabelRef.current = removeMentionLabel;
  availableSkillsRef.current = availableSkills;
  availableCapabilitiesRef.current = availableCapabilities;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions,
    content: plainTextToAgentRichTextDoc(value, {
      capabilities: availableCapabilities,
      skills: availableSkills
    }),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": placeholder,
        "aria-disabled": disabled ? "true" : "false",
        "aria-multiline": "true",
        class: cn(
          className,
          "overflow-y-auto whitespace-pre-wrap break-words [&_p]:m-0"
        )
      },
      clipboardTextSerializer: (slice) =>
        agentRichTextContentToPromptText(slice.content.toJSON()),
      handleDOMEvents: {
        click: (_view, event) => {
          if (!onLinkClickRef.current || !(event.target instanceof Element)) {
            return false;
          }
          const mention = event.target.closest(
            '[data-agent-file-mention="true"]'
          );
          if (!(mention instanceof HTMLElement)) {
            return false;
          }
          const href =
            mention instanceof HTMLAnchorElement
              ? mention.getAttribute("href") || ""
              : mention.getAttribute("data-agent-mention-href") || "";
          if (!href) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          onLinkClickRef.current(href);
          return true;
        },
        contextmenu: (_view, event) => {
          const currentEditor = editorRef.current;
          if (!currentEditor || currentEditor.isDestroyed) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          const stateSelection = currentEditor.state.selection;
          const domSelection = stateSelection.empty
            ? readEditorDomSelectionRange(currentEditor)
            : null;
          const from = domSelection?.from ?? stateSelection.from;
          const to = domSelection?.to ?? stateSelection.to;
          setContextMenu({
            canEdit: !disabled,
            hasSelection: from < to,
            selectionFrom: from,
            selectionTo: to,
            x: event.clientX,
            y: event.clientY
          });
          return true;
        },
        copy: (_view, event) => {
          const currentEditor = editorRef.current;
          if (
            !currentEditor ||
            currentEditor.isDestroyed ||
            !event.clipboardData
          ) {
            return false;
          }
          const selection = readPromptSelection(currentEditor);
          if (!selection.text) {
            return false;
          }
          event.clipboardData.setData("text/plain", selection.text);
          event.preventDefault();
          return true;
        },
        cut: (_view, event) => {
          const currentEditor = editorRef.current;
          if (
            disabled ||
            !currentEditor ||
            currentEditor.isDestroyed ||
            !event.clipboardData
          ) {
            return false;
          }
          const selection = readPromptSelection(currentEditor);
          if (!selection.text) {
            return false;
          }
          event.clipboardData.setData("text/plain", selection.text);
          event.preventDefault();
          currentEditor.commands.deleteRange({
            from: selection.from,
            to: selection.to
          });
          return true;
        },
        paste: (_view, event) => {
          const imageFiles = imageFilesFromDataTransfer(event.clipboardData);
          if (imageFiles.length > 0) {
            event.preventDefault();
            if (!promptImagesSupportedRef.current) {
              onPromptImagesUnsupportedRef.current?.();
              return true;
            }
            void readAgentRichTextPromptImages(imageFiles).then((images) => {
              if (images.length > 0) {
                onPasteImagesRef.current?.(images);
              }
            });
            return true;
          }
          const getReferenceForFileFn = getReferenceForFileRef.current;
          if (getReferenceForFileFn) {
            const nonImageFiles = nonImageFilesFromDataTransfer(
              event.clipboardData
            );
            if (nonImageFiles.length > 0) {
              const references = nonImageFiles
                .map((file) => {
                  try {
                    return getReferenceForFileFn(file);
                  } catch {
                    return null;
                  }
                })
                .filter((reference): reference is WorkspaceFileReference =>
                  Boolean(reference?.path)
                );
              if (references.length > 0) {
                event.preventDefault();
                const currentEditor = editorRef.current;
                if (!currentEditor) {
                  return true;
                }
                if (!currentEditor.isFocused) {
                  currentEditor.commands.setTextSelection(
                    currentEditor.state.doc.content.size
                  );
                }
                currentEditor.commands.insertContent(
                  createAgentFileMentionContent(references, {
                    prefixCaretAnchor: isPromptVisualLineStart(
                      currentEditor,
                      currentEditor.state.selection.from
                    )
                  })
                );
                return true;
              }
            }
          }
          const html = event.clipboardData?.getData("text/html") ?? "";
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const textPasteKind = classifyAgentRichTextTextPaste(
            text,
            html,
            Boolean(onPasteLargeTextRef.current)
          );
          if (textPasteKind === "empty") {
            return false;
          }
          if (textPasteKind === "large-text") {
            event.preventDefault();
            onPasteLargeTextRef.current?.(text);
            return true;
          }
          if (textPasteKind === "structured-mention") {
            return false;
          }
          event.preventDefault();
          const currentEditor = editorRef.current;
          if (!currentEditor) {
            return true;
          }
          if (!currentEditor.isFocused) {
            currentEditor.commands.setTextSelection(
              currentEditor.state.doc.content.size
            );
          }
          suppressPastedAtSuggestionRef.current =
            text.includes("@") && !text.endsWith("@");
          if (suppressPastedAtSuggestionRef.current) {
            releasePastedAtSuggestionSuppression(suppressPastedAtSuggestionRef);
          }
          currentEditor.commands.insertContent(
            plainTextToAgentRichTextInlineContent(text, {
              capabilities: availableCapabilitiesRef.current,
              skills: availableSkillsRef.current
            })
          );
          return true;
        },
        keydown: (_view, event) => {
          if (isAgentRichTextImeComposing(event)) {
            return false;
          }
          if (disabled) {
            return false;
          }
          if (onKeyDownForPaletteRef.current?.(event)) {
            return true;
          }
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            if (!submitOnEnter) {
              return true;
            }
            onSubmitGuidanceRef.current?.();
            return true;
          }
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          ) {
            return false;
          }
          if (!submitOnEnter) {
            return false;
          }
          event.preventDefault();
          onSubmitRef.current();
          return true;
        },
        dragover: (_view, event) => {
          const dataTransfer = event.dataTransfer;
          if (!dataTransfer || disabled) {
            return false;
          }
          const systemFileDragInfo =
            systemFileDragInfoFromDataTransfer(dataTransfer);
          const canDropRegularSystemFiles =
            systemFileDragInfo.hasRegularFiles &&
            Boolean(onDropFilesRef.current);
          if (systemFileDragInfo.hasImageFiles || canDropRegularSystemFiles) {
            event.preventDefault();
            dataTransfer.dropEffect =
              canDropRegularSystemFiles ||
              (systemFileDragInfo.hasImageFiles &&
                promptImagesSupportedRef.current)
                ? "copy"
                : "none";
            return true;
          }
          if (!hasWorkspaceFileDropData(dataTransfer)) {
            return false;
          }
          const entries = readWorkspaceFileDropEntries(dataTransfer);
          if (entries.length === 0) {
            return false;
          }
          event.preventDefault();
          dataTransfer.dropEffect = "copy";
          return true;
        },
        drop: (_view, event) => {
          const dataTransfer = event.dataTransfer;
          if (!dataTransfer || disabled) {
            return false;
          }
          const imageFiles = imageFilesFromDataTransfer(dataTransfer);
          const imageFileSet = new Set(imageFiles);
          const regularFiles = nonImageFilesFromDataTransfer(
            dataTransfer
          ).filter((file) => !imageFileSet.has(file));
          const canHandleRegularFiles = Boolean(onDropFilesRef.current);
          if (
            imageFiles.length > 0 ||
            (regularFiles.length > 0 && canHandleRegularFiles)
          ) {
            event.preventDefault();
            const currentEditor = editorRef.current;
            if (
              regularFiles.length > 0 &&
              onDropFilesRef.current &&
              currentEditor &&
              !currentEditor.isDestroyed
            ) {
              const coordinatePosition = currentEditor.view.posAtCoords({
                left: event.clientX,
                top: event.clientY
              })?.pos;
              const fallbackSelectionPosition =
                currentEditor.state.selection.from;
              const insertPosition =
                coordinatePosition ??
                (Number.isInteger(fallbackSelectionPosition)
                  ? fallbackSelectionPosition
                  : null) ??
                currentEditor.state.doc.content.size;
              currentEditor
                .chain()
                .focus()
                .setTextSelection(insertPosition)
                .run();
              onDropFilesRef.current(regularFiles);
            }
            if (imageFiles.length === 0) {
              return true;
            }
            if (!promptImagesSupportedRef.current) {
              onPromptImagesUnsupportedRef.current?.();
              return true;
            }
            void readAgentRichTextPromptImages(imageFiles).then((images) => {
              if (images.length > 0) {
                onPasteImagesRef.current?.(images);
              }
            });
            return true;
          }
          if (!hasWorkspaceFileDropData(dataTransfer)) {
            return false;
          }
          event.preventDefault();
          const currentEditor = editorRef.current;
          if (!currentEditor || currentEditor.isDestroyed) {
            return true;
          }
          const entries = readWorkspaceFileDropEntries(dataTransfer);
          if (entries.length === 0) {
            return true;
          }
          const coordinatePosition = currentEditor.view.posAtCoords({
            left: event.clientX,
            top: event.clientY
          })?.pos;
          const fallbackSelectionPosition = currentEditor.state.selection.from;
          const insertPosition =
            coordinatePosition ??
            (Number.isInteger(fallbackSelectionPosition)
              ? fallbackSelectionPosition
              : null) ??
            currentEditor.state.doc.content.size;
          currentEditor
            .chain()
            .focus()
            .insertContentAt(
              insertPosition,
              buildWorkspaceFileMentionDropContent(entries, {
                prefixCaretAnchor: isPromptVisualLineStart(
                  currentEditor,
                  insertPosition
                )
              })
            )
            .run();
          return true;
        }
      }
    },
    onUpdate: ({ editor: nextEditor, transaction }) => {
      editorRef.current = nextEditor;
      scheduleSelectionScroll(nextEditor);
      const nextPrompt = editorToPromptText(nextEditor);
      if (nextPrompt === lastEmittedPromptRef.current) {
        return;
      }
      lastEmittedPromptRef.current = nextPrompt;
      if (isAgentRichTextUserContentInsertion(transaction)) {
        onUserContentChangeRef.current?.(nextPrompt);
      }
      onChangeRef.current(nextPrompt);
    },
    onFocus: ({ editor: nextEditor }) => {
      const pendingMethod = pendingFocusMethodRef.current;
      const focusMethod =
        pendingMethod ??
        (nextEditor.view.dom.matches(":focus-visible")
          ? "keyboard"
          : "programmatic");
      pendingFocusMethodRef.current = null;
      onFocusRef.current?.(focusMethod);
    },
    onBlur: () => {
      pendingFocusMethodRef.current = null;
    },
    onCreate: ({ editor: nextEditor }) => {
      editorRef.current = nextEditor;
      nextEditor.commands.setTextSelection(nextEditor.state.doc.content.size);
    }
  });

  const handleKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ): void => {
    handleAgentRichTextKeyDownCapture(event, {
      disabled,
      editorRef,
      onKeyDownForPaletteRef,
      onSubmitGuidanceRef,
      onSubmitRef,
      submitOnEnter
    });
  };
  useEffect(
    () => () => {
      if (
        scrollFrameRef.current !== null &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const close = () => closeContextMenu();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeContextMenu, contextMenu]);

  useAgentRichTextEditorHandle({
    availableCapabilitiesRef,
    availableSkillsRef,
    editorRef,
    onBeforeProgrammaticFocus: () => {
      pendingFocusMethodRef.current = "programmatic";
    },
    ref
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.setEditable(!disabled);
    editor.view.dom.setAttribute("aria-disabled", disabled ? "true" : "false");
    editor.view.dom.setAttribute("aria-label", placeholder);
    editor.view.dispatch(
      editor.state.tr.setMeta("agentRichTextPlaceholder", placeholder)
    );
  }, [disabled, editor, placeholder]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    if (value === lastEmittedPromptRef.current) {
      return;
    }
    const nextDoc = plainTextToAgentRichTextDoc(value, {
      capabilities: availableCapabilities,
      skills: availableSkills
    });
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(nextDoc)) {
      lastEmittedPromptRef.current = value;
      return;
    }
    editor.commands.setContent(nextDoc, { emitUpdate: false });
    editor.commands.setTextSelection(editor.state.doc.content.size);
    lastEmittedPromptRef.current = value;
  }, [availableCapabilities, availableSkills, editor, value]);

  return (
    <AgentRichTextEditorSurface
      className={className}
      contextMenu={contextMenu}
      copySelection={copySelection}
      cutSelection={cutSelection}
      disabled={disabled}
      editor={editor}
      handleKeyDownCapture={handleKeyDownCapture}
      handlePointerDownCapture={() =>
        markAgentRichTextPointerFocus(pendingFocusMethodRef)
      }
      pasteClipboardText={pasteClipboardText}
      placeholder={placeholder}
      t={t}
    />
  );
});

function releasePastedAtSuggestionSuppression(ref: { current: boolean }): void {
  // timing: keep suppression through the synchronous editor insertion only.
  window.setTimeout(() => {
    ref.current = false;
  }, 0);
}
