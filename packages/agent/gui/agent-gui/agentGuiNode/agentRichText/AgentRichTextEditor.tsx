import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { cn } from "../../../app/renderer/lib/utils";
import { useTranslation } from "../../../i18n/index";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import { createAgentRichTextInputExtensions } from "./agentRichTextExtensions";
import type {
  AgentFileMentionKind,
  AgentFileMentionSuggestionState
} from "./agentFileMentionExtension";
import {
  agentRichTextContentToPromptText,
  editorToPromptText,
  plainTextToAgentRichTextInlineContent,
  plainTextToAgentRichTextDoc
} from "./agentRichTextDocument";
import { AGENT_RICH_TEXT_CARET_ANCHOR } from "./agentRichTextCaretAnchor";
import {
  createAgentFileMentionContent,
  createAgentMentionContent
} from "./agentWorkspaceFileReferences";
import type { AgentContextMentionItem } from "./agentFileMentionExtension";
import { isAgentRichTextImeComposing } from "./agentRichTextIme";
import {
  hasWorkspaceFileDropData,
  readWorkspaceFileDropEntries
} from "../../terminalNode/workspaceFileDrop";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import {
  imageFilesFromDataTransfer,
  nonImageFilesFromDataTransfer,
  readAgentRichTextPromptImages,
  systemFileDragInfoFromDataTransfer,
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
  onSubmitGuidance?: () => void;
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
  onPasteLargeText?: (text: string) => void;
  getReferenceForFile?: (file: File) => WorkspaceFileReference | null;
  onDropFiles?: (files: readonly File[]) => void;
}

export interface AgentRichTextEditorHandle {
  focusAtStart: () => void;
  focusAtEnd: () => void;
  getPromptTextBeforeSelection: () => string;
  openMentionPalette: () => void;
  insertWorkspaceReferences: (items: readonly WorkspaceFileReference[]) => void;
  insertMentionItems: (items: readonly AgentContextMentionItem[]) => void;
  replaceTextBeforeSelection: (length: number, text: string) => string | null;
}

export type AgentRichTextPastedImage = AgentRichTextPromptImage;

interface AgentRichTextContextMenuState {
  canEdit: boolean;
  hasSelection: boolean;
  selectionFrom: number;
  selectionTo: number;
  x: number;
  y: number;
}

const AGENT_RICH_TEXT_LARGE_PASTE_MIN_CHARS = 2_000;
const AGENT_RICH_TEXT_LARGE_PASTE_MIN_LINES = 12;

export function isAgentRichTextLargeTextPaste(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < AGENT_RICH_TEXT_LARGE_PASTE_MIN_CHARS) {
    const lineCount = trimmed ? trimmed.split(/\r\n|\r|\n/).length : 0;
    return lineCount >= AGENT_RICH_TEXT_LARGE_PASTE_MIN_LINES;
  }
  return true;
}

function buildWorkspaceFileMentionDropContent(
  entries: ReadonlyArray<{
    path: string;
    name: string;
    kind: AgentFileMentionKind;
  }>,
  options: { prefixCaretAnchor?: boolean } = {}
): JSONContent[] {
  return entries.flatMap((entry, index) => [
    ...(index === 0 && options.prefixCaretAnchor
      ? ([
          { type: "text", text: AGENT_RICH_TEXT_CARET_ANCHOR }
        ] as JSONContent[])
      : []),
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

function isPromptVisualLineStart(editor: Editor, position: number): boolean {
  if (position <= 1) {
    return true;
  }
  return (
    editor.state.doc.textBetween(
      Math.max(1, position - 1),
      position,
      "\n",
      "\n"
    ) === "\n"
  );
}

function isMentionTriggerBoundaryBeforeSelection(editor: Editor): boolean {
  const position = editor.state.selection.from;
  if (position <= 1) {
    return true;
  }
  const previous = editor.state.doc.textBetween(
    Math.max(1, position - 1),
    position,
    "\n",
    "\n"
  );
  return previous === "" || /\s/.test(previous);
}

function findCaretAnchorBeforeAtomicRun(
  doc: ProseMirrorNode,
  position: number
): number | null {
  let anchorPosition: number | null = null;
  doc.descendants((node, nodePosition) => {
    if (nodePosition >= position) {
      return false;
    }
    if (node.isText) {
      const text = node.text ?? "";
      for (let offset = 0; offset < text.length; offset += 1) {
        const characterPosition = nodePosition + offset;
        if (characterPosition >= position) {
          return false;
        }
        if (text[offset] === AGENT_RICH_TEXT_CARET_ANCHOR) {
          anchorPosition = characterPosition;
          continue;
        }
        if (anchorPosition !== null) {
          anchorPosition = null;
        }
      }
      return true;
    }
    if (node.type.name === "agentFileMention") {
      return false;
    }
    if (node.isInline && anchorPosition !== null) {
      anchorPosition = null;
    }
    return true;
  });
  return anchorPosition;
}

function moveSelectionOverCaretAnchor(
  state: EditorState,
  dispatch: (transaction: Transaction) => void,
  key: string
): boolean {
  const { doc, selection } = state;
  if (!selection.empty) {
    return false;
  }
  const position = selection.from;
  if (key === "ArrowLeft") {
    const anchorPosition = findCaretAnchorBeforeAtomicRun(doc, position);
    if (anchorPosition === null) {
      return false;
    }
    dispatch(state.tr.setSelection(TextSelection.create(doc, anchorPosition)));
    return true;
  }
  if (
    key === "ArrowRight" &&
    position < doc.content.size &&
    doc.textBetween(position, position + 1) === AGENT_RICH_TEXT_CARET_ANCHOR
  ) {
    const afterAnchor = position + 1;
    const mentionAfterAnchor = doc.resolve(afterAnchor).nodeAfter;
    dispatch(
      state.tr.setSelection(
        TextSelection.create(
          doc,
          afterAnchor +
            (mentionAfterAnchor?.type.name === "agentFileMention"
              ? mentionAfterAnchor.nodeSize
              : 0)
        )
      )
    );
    return true;
  }
  return false;
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

function createAgentRichTextCaretAnchorExtension(): Extension {
  return Extension.create({
    name: "agentRichTextCaretAnchor",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("agentRichTextCaretAnchor"),
          props: {
            handleKeyDown(view, event) {
              if (
                (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
                event.shiftKey ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              ) {
                return false;
              }
              if (
                moveSelectionOverCaretAnchor(
                  view.state,
                  (transaction) => view.dispatch(transaction),
                  event.key
                )
              ) {
                event.preventDefault();
                return true;
              }
              return false;
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

function readSelectedPlainText(editor: Editor): string {
  return readPromptSelection(editor).text;
}

function readPromptSelection(editor: Editor): {
  from: number;
  text: string;
  to: number;
} {
  const selection = editor.state.selection;
  const domSelection = selection.empty
    ? readEditorDomSelectionRange(editor)
    : null;
  const from = domSelection?.from ?? selection.from;
  const to = domSelection?.to ?? selection.to;
  return {
    from,
    text: readPromptTextRange(editor, from, to),
    to
  };
}

function readPromptTextRange(editor: Editor, from: number, to: number): string {
  if (from === to) {
    return "";
  }
  return agentRichTextContentToPromptText(
    editor.state.doc.slice(from, to).content.toJSON()
  );
}

function readEditorDomSelectionRange(
  editor: Editor
): { from: number; to: number } | null {
  const dom = editor.view.dom;
  const selection = dom.ownerDocument.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !selection.focusNode ||
    selection.isCollapsed ||
    !dom.contains(selection.anchorNode) ||
    !dom.contains(selection.focusNode)
  ) {
    return null;
  }

  try {
    const anchor = editor.view.posAtDOM(
      selection.anchorNode,
      selection.anchorOffset
    );
    const focus = editor.view.posAtDOM(
      selection.focusNode,
      selection.focusOffset
    );
    if (anchor === focus) {
      return null;
    }
    return {
      from: Math.min(anchor, focus),
      to: Math.max(anchor, focus)
    };
  } catch {
    return null;
  }
}

async function writePlainTextToClipboard(text: string): Promise<boolean> {
  if (!text || typeof navigator.clipboard?.writeText !== "function") {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function readPlainTextFromClipboard(): Promise<string | null> {
  if (typeof navigator.clipboard?.readText !== "function") {
    return null;
  }

  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
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
      window.setTimeout(() => {
        suppressPastedAtSuggestionRef.current = false;
      }, 0);
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
          "overflow-y-auto whitespace-pre-wrap break-words [&_p]:m-0 [&_p]:min-h-[1.45em]"
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
          if (html.includes("data-agent-file-mention")) {
            return false;
          }
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!text) {
            return false;
          }
          event.preventDefault();
          if (
            onPasteLargeTextRef.current &&
            isAgentRichTextLargeTextPaste(text)
          ) {
            onPasteLargeTextRef.current(text);
            return true;
          }
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
            window.setTimeout(() => {
              suppressPastedAtSuggestionRef.current = false;
            }, 0);
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
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const currentEditor = editorRef.current;
      if (
        currentEditor &&
        !currentEditor.isDestroyed &&
        moveSelectionOverCaretAnchor(
          currentEditor.state,
          (transaction) => currentEditor.view.dispatch(transaction),
          event.key
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!submitOnEnter) {
        return;
      }
      onSubmitGuidanceRef.current?.();
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

  useImperativeHandle(
    ref,
    () => ({
      focusAtStart() {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .setTextSelection(1)
          .scrollIntoView()
          .run();
      },
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
      openMentionPalette() {
        const currentEditor = editorRef.current;
        if (
          !currentEditor ||
          currentEditor.isDestroyed ||
          !currentEditor.isEditable
        ) {
          return;
        }
        const triggerText = isMentionTriggerBoundaryBeforeSelection(
          currentEditor
        )
          ? "@"
          : " @";
        currentEditor.chain().focus().insertContent(triggerText).run();
      },
      insertWorkspaceReferences(items) {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || items.length === 0) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .insertContent(
            createAgentFileMentionContent(items, {
              prefixCaretAnchor: isPromptVisualLineStart(
                currentEditor,
                currentEditor.state.selection.from
              )
            })
          )
          .run();
      },
      insertMentionItems(items) {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed || items.length === 0) {
          return;
        }
        currentEditor
          .chain()
          .focus()
          .insertContent(
            createAgentMentionContent(items, {
              prefixCaretAnchor: isPromptVisualLineStart(
                currentEditor,
                currentEditor.state.selection.from
              )
            })
          )
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
      {contextMenu
        ? createPortal(
            <div
              role="menu"
              aria-label={t("agentHost.agentGui.composerTextMenu")}
              className="fixed z-[var(--z-popover)] min-w-[132px] rounded-[8px] border border-[var(--line-1)] bg-[var(--background-panel)] p-1 text-[13px] text-[var(--text-primary)] shadow-[0_14px_34px_rgb(0_0_0_/_0.28)]"
              data-agent-composer-text-menu="true"
              style={{
                left: contextMenu.x,
                top: contextMenu.y
              }}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AgentRichTextContextMenuButton
                disabled={!contextMenu.canEdit || !contextMenu.hasSelection}
                label={t("common.cut")}
                onSelect={cutSelection}
              />
              <AgentRichTextContextMenuButton
                disabled={!contextMenu.hasSelection}
                label={t("common.copy")}
                onSelect={copySelection}
              />
              <AgentRichTextContextMenuButton
                disabled={!contextMenu.canEdit}
                label={t("common.paste")}
                onSelect={pasteClipboardText}
              />
            </div>,
            document.body
          )
        : null}
    </div>
  );
});

function AgentRichTextContextMenuButton({
  disabled,
  label,
  onSelect
}: {
  disabled: boolean;
  label: string;
  onSelect: () => void | Promise<void>;
}): React.JSX.Element {
  const selectionStartedRef = useRef(false);
  const select = useCallback(() => {
    if (disabled || selectionStartedRef.current) {
      return;
    }
    selectionStartedRef.current = true;
    void Promise.resolve(onSelect()).finally(() => {
      selectionStartedRef.current = false;
    });
  }, [disabled, onSelect]);

  return (
    <button
      role="menuitem"
      className="block w-full rounded-[6px] px-3 py-1.5 text-left font-medium transition-colors hover:bg-[var(--transparency-hover)] focus-visible:bg-[var(--transparency-hover)] focus-visible:outline-none disabled:cursor-default disabled:opacity-45"
      disabled={disabled}
      type="button"
      onClick={() => {
        select();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        select();
      }}
    >
      {label}
    </button>
  );
}
