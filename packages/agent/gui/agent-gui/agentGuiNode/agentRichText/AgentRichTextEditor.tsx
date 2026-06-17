import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "../../../app/renderer/lib/utils";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import { createAgentRichTextInputExtensions } from "./agentRichTextExtensions";
import type {
  AgentFileMentionKind,
  AgentFileMentionSuggestionState
} from "./agentFileMentionExtension";
import {
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
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import {
  imageFilesFromDataTransfer,
  readAgentRichTextPromptImages,
  type AgentRichTextPromptImage
} from "./agentRichTextPromptImages";

export interface AgentRichTextEditorProps {
  value: string;
  disabled: boolean;
  placeholder: string;
  removeMentionLabel?: string;
  className?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  availableCapabilities?: readonly AgentCapabilityTokenOption[];
  submitOnEnter?: boolean;
  enableFileMentionSuggestions?: boolean;
  onKeyDownForPalette?: (event: KeyboardEvent) => boolean;
  onFileMentionSuggestionChange?: (
    state: AgentFileMentionSuggestionState | null
  ) => void;
  onFileMentionSuggestionKeyDown?: (event: KeyboardEvent) => boolean;
  onLinkClick?: (href: string) => void;
  promptImagesSupported?: boolean;
  onPromptImagesUnsupported?: () => void;
  onPasteImages?: (images: AgentRichTextPastedImage[]) => void;
}

export interface AgentRichTextEditorHandle {
  focusAtEnd: () => void;
  getPromptTextBeforeSelection: () => string;
  insertWorkspaceReferences: (items: readonly WorkspaceFileReference[]) => void;
  replaceTextBeforeSelection: (length: number, text: string) => string | null;
}

export type AgentRichTextPastedImage = AgentRichTextPromptImage;

function buildWorkspaceFileMentionDropContent(
  entries: ReadonlyArray<{
    path: string;
    name: string;
    kind: AgentFileMentionKind;
  }>
): JSONContent[] {
  return entries.flatMap((entry) => [
    {
      type: "agentFileMention",
      attrs: {
        kind: "file",
        href: entry.path,
        path: entry.path,
        name: entry.name,
        entryKind: entry.kind
      }
    },
    { type: "text", text: " " }
  ]);
}

function createAgentRichTextPlaceholderExtension(
  getPlaceholder: () => string
): Extension {
  return Extension.create({
    name: "agentRichTextPlaceholder",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("agentRichTextPlaceholder"),
          props: {
            decorations(state) {
              const firstNode = state.doc.firstChild;
              const isEmptyPrompt =
                state.doc.childCount === 1 &&
                firstNode?.type.name === "paragraph" &&
                firstNode.content.size === 0;

              if (!firstNode || !isEmptyPrompt) {
                return DecorationSet.empty;
              }

              return DecorationSet.create(state.doc, [
                Decoration.node(0, firstNode.nodeSize, {
                  class: "agent-rich-text-placeholder-node",
                  "data-agent-rich-text-placeholder": getPlaceholder()
                })
              ]);
            }
          }
        })
      ];
    }
  });
}

function scrollEditorSelectionIntoView(editor: Editor): void {
  const scrollContainer = editor.view.dom;
  if (!(scrollContainer instanceof HTMLElement)) {
    return;
  }

  const maxScrollTop =
    scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (maxScrollTop <= 0) {
    return;
  }

  const promptEnd = editor.state.doc.content.size;
  if (editor.state.selection.to >= Math.max(0, promptEnd - 1)) {
    scrollContainer.scrollTop = maxScrollTop;
    return;
  }

  const selection = scrollContainer.ownerDocument.getSelection();
  const anchorNode = selection?.anchorNode ?? null;
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !anchorNode ||
    !scrollContainer.contains(anchorNode)
  ) {
    return;
  }

  const selectionRect = selection.getRangeAt(0).getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const overflowBottom = selectionRect.bottom - containerRect.bottom;
  if (overflowBottom > 0) {
    scrollContainer.scrollTop = Math.min(
      maxScrollTop,
      scrollContainer.scrollTop + overflowBottom
    );
    return;
  }

  const overflowTop = containerRect.top - selectionRect.top;
  if (overflowTop > 0) {
    scrollContainer.scrollTop = Math.max(
      0,
      scrollContainer.scrollTop - overflowTop
    );
  }
}

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
    onSubmit,
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
    onPasteImages
  },
  ref
): React.JSX.Element {
  "use memo";
  const lastEmittedPromptRef = useRef<string | null>(value);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
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
  const promptImagesSupportedRef = useRef(promptImagesSupported);
  const placeholderRef = useRef(placeholder);
  const removeMentionLabelRef = useRef(removeMentionLabel);
  const availableSkillsRef = useRef(availableSkills);
  const availableCapabilitiesRef = useRef(availableCapabilities);
  const scrollFrameRef = useRef<number | null>(null);

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
          removeActionAriaLabel: removeMentionLabelRef.current
        },
        { skills: availableSkillsRef.current },
        { capabilities: availableCapabilitiesRef.current }
      ),
      createAgentRichTextPlaceholderExtension(() => placeholderRef.current)
    ],
    [enableFileMentionSuggestions]
  );

  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  onKeyDownForPaletteRef.current = onKeyDownForPalette;
  onFileMentionSuggestionChangeRef.current = onFileMentionSuggestionChange;
  onFileMentionSuggestionKeyDownRef.current = onFileMentionSuggestionKeyDown;
  onLinkClickRef.current = onLinkClick;
  onPromptImagesUnsupportedRef.current = onPromptImagesUnsupported;
  onPasteImagesRef.current = onPasteImages;
  promptImagesSupportedRef.current = promptImagesSupported;
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
          "overflow-y-auto whitespace-pre-wrap break-words [&_p]:m-0 [&_p]:min-h-[1.45em]"
        )
      },
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
          const html = event.clipboardData?.getData("text/html") ?? "";
          if (html.includes("data-agent-file-mention")) {
            return false;
          }
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!text) {
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
          const imageFiles = imageFilesFromDataTransfer(dataTransfer);
          if (imageFiles.length > 0) {
            event.preventDefault();
            dataTransfer.dropEffect = promptImagesSupportedRef.current
              ? "copy"
              : "none";
            return true;
          }
          if (!hasWorkspaceFileDropData(dataTransfer)) {
            return false;
          }
          const entries = readWorkspaceFileDropEntries(dataTransfer, {
            includeLegacyPaths: false
          });
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
          if (!hasWorkspaceFileDropData(dataTransfer)) {
            return false;
          }
          event.preventDefault();
          const currentEditor = editorRef.current;
          if (!currentEditor || currentEditor.isDestroyed) {
            return true;
          }
          const entries = readWorkspaceFileDropEntries(dataTransfer, {
            includeLegacyPaths: false
          });
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
              buildWorkspaceFileMentionDropContent(entries)
            )
            .run();
          return true;
        }
      }
    },
    onUpdate: ({ editor: nextEditor }) => {
      editorRef.current = nextEditor;
      scheduleSelectionScroll(nextEditor);
      const nextPrompt = editorToPromptText(nextEditor);
      if (nextPrompt === lastEmittedPromptRef.current) {
        return;
      }
      lastEmittedPromptRef.current = nextPrompt;
      onChangeRef.current(nextPrompt);
    },
    onCreate: ({ editor: nextEditor }) => {
      editorRef.current = nextEditor;
      nextEditor.commands.setTextSelection(nextEditor.state.doc.content.size);
    }
  });

  const handleKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ): void => {
    if (isAgentRichTextImeComposing(event.nativeEvent)) {
      return;
    }
    if (disabled) {
      return;
    }
    if (onKeyDownForPaletteRef.current?.(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!submitOnEnter) {
      return;
    }
    onSubmitRef.current();
  };

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

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

  useImperativeHandle(
    ref,
    () => ({
      focusAtEnd() {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return;
        }
        const end = currentEditor.state.doc.content.size;
        currentEditor.chain().focus().setTextSelection(end).run();
      },
      getPromptTextBeforeSelection() {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return "";
        }
        return currentEditor.state.doc.textBetween(
          0,
          currentEditor.state.selection.from,
          "\n",
          "\n"
        );
      },
      insertWorkspaceReferences(items) {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || items.length === 0) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .insertContent(createAgentFileMentionContent(items))
          .run();
      },
      replaceTextBeforeSelection(length, text) {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || length <= 0) {
          return null;
        }
        const to = currentEditor.state.selection.from;
        const from = Math.max(1, to - length);
        currentEditor
          .chain()
          .focus()
          .insertContentAt(
            { from, to },
            plainTextToAgentRichTextInlineContent(text, {
              capabilities: availableCapabilitiesRef.current,
              skills: availableSkillsRef.current
            })
          )
          .run();
        return editorToPromptText(currentEditor);
      }
    }),
    []
  );

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
    <div className="relative min-w-0" onKeyDownCapture={handleKeyDownCapture}>
      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        <div
          role="textbox"
          aria-label={placeholder}
          aria-disabled={disabled ? "true" : "false"}
          aria-multiline="true"
          className={cn(
            className,
            "overflow-y-auto whitespace-pre-wrap break-words [&_p]:m-0 [&_p]:min-h-[1.45em]"
          )}
        />
      )}
    </div>
  );
});
