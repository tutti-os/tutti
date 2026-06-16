import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type JSX
} from "react";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { ViewportMenuSurface } from "@tutti-os/ui-system/components";
import { cn } from "@tutti-os/ui-system/utils";
import { createRichTextMentionAttrs } from "../plugins/index.ts";
import { createRichTextAtRegistry } from "../plugins/atRegistry.ts";
import type {
  RichTextAtInsertResult,
  RichTextAtProviderContext,
  RichTextAtProvider,
  RichTextAtQueryMatch
} from "../types/at.ts";
import {
  normalizeRichTextContent,
  normalizeRichTextLinkHref,
  parseRichTextContentToDocument,
  serializeRichTextDocumentToContent
} from "../core/richTextDocument.ts";
import {
  findRichTextAtQuery,
  queryRichTextAtMatches
} from "./richTextAtQuery.ts";
import { isRichTextImeComposing } from "./richTextIme.ts";
import {
  resolveRichTextAtText,
  type RichTextAtTextOverrides
} from "./richTextAtText.ts";
import {
  createRichTextAtEditorMatchEntries,
  createRichTextAtEditorMatchEntry,
  findRichTextAtEditorEntryKeyForMatch,
  findRichTextAtEditorNavigationEntry,
  haveSameRichTextAtEditorNavigationEntries,
  isSameRichTextAtEditorMatch,
  moveRichTextAtEditorActiveEntryKey,
  resolveRichTextAtEditorActiveEntryKey,
  richTextAtEditorMatchEntryKey,
  type RichTextAtEditorNavigationEntry
} from "./richTextAtEditorNavigation.ts";
import type { RichTextI18nRuntime } from "../i18n/richTextI18n.ts";
import { MentionReference } from "../extensions/mentionReference.ts";
import { WorkspaceReference } from "../extensions/workspaceReference.ts";
import {
  mentionReferenceNodeName,
  workspaceReferenceNodeName
} from "../extensions/names.ts";

export interface RichTextAtEditorProps {
  value: string;
  onChange: (value: string) => void;
  providers?: readonly RichTextAtProvider[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  textareaClassName?: string;
  placeholderClassName?: string;
  minQueryLength?: number;
  maxResults?: number;
  removeDecorationAriaLabel?: string;
  i18n?: RichTextI18nRuntime;
  textOverrides?: RichTextAtTextOverrides;
  overlay?: ReactNode;
  focusSignal?: unknown;
  renderPanel?: (context: RichTextAtEditorPanelContext) => ReactNode;
  // Tab/Shift+Tab cycle the at-panel filter tabs (parity with the agent
  // composer). When omitted, Tab is left to the browser.
  onCycleFilter?: (delta: 1 | -1) => void;
}

type RichTextEditorAtQueryState = {
  from: number;
  keyword: string;
  to: number;
};

export interface RichTextAtEditorPanelContext {
  activeEntryKey: string | null;
  activeIndex: number;
  activeMatch: RichTextAtQueryMatch | null;
  isLoading: boolean;
  matches: readonly RichTextAtQueryMatch[];
  maxResults: number;
  navigationEntries: readonly RichTextAtEditorNavigationEntry[];
  onActiveEntryKeyChange: (key: string | null) => void;
  onActiveIndexChange: (index: number) => void;
  onActiveMatchChange: (match: RichTextAtQueryMatch | null) => void;
  onNavigationEntriesChange: (
    entries: readonly RichTextAtEditorNavigationEntry[] | null
  ) => void;
  onNavigationMatchesChange: (
    matches: readonly RichTextAtQueryMatch[] | null
  ) => void;
  onMoveSelection: (delta: 1 | -1) => void;
  onSelect: (match: RichTextAtQueryMatch) => void;
  providerContext: RichTextAtProviderContext;
  providers: readonly RichTextAtProvider[];
  query: RichTextEditorAtQueryState;
  text: ReturnType<typeof resolveRichTextAtText>;
}

export function RichTextAtEditor({
  value,
  onChange,
  providers = [],
  placeholder,
  disabled = false,
  className,
  textareaClassName,
  placeholderClassName,
  minQueryLength = 0,
  maxResults = 8,
  removeDecorationAriaLabel,
  i18n,
  textOverrides,
  overlay,
  focusSignal,
  renderPanel,
  onCycleFilter
}: RichTextAtEditorProps): JSX.Element {
  const menuOffset = 6;
  const normalizedValue = normalizeRichTextContent(value);
  const text = resolveRichTextAtText(
    textOverrides,
    removeDecorationAriaLabel,
    i18n
  );
  const latestOnChangeRef = useRef(onChange);
  const lastSerializedValueRef = useRef(normalizedValue);
  const lastFocusSignalRef = useRef(focusSignal);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const registry = useMemo(
    () => createRichTextAtRegistry(providers),
    [providers]
  );
  const [isFocused, setIsFocused] = useState(false);
  const [query, setQuery] = useState<RichTextEditorAtQueryState | null>(null);
  const [matches, setMatches] = useState<readonly RichTextAtQueryMatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeEntryKey, setActiveEntryKey] = useState<string | null>(null);
  const [panelNavigationEntries, setPanelNavigationEntries] = useState<
    readonly RichTextAtEditorNavigationEntry[] | null
  >(null);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(
    null
  );

  latestOnChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      WorkspaceReference.configure({
        removeActionAriaLabel: text.removeReferenceActionLabel
      }),
      MentionReference
    ],
    content: parseRichTextContentToDocument(normalizedValue),
    editorProps: {
      attributes: {
        class: cn(
          "w-full whitespace-pre-wrap break-words outline-none",
          textareaClassName
        )
      }
    },
    onBlur() {
      window.setTimeout(() => {
        setIsFocused(false);
        setMatches([]);
        setIsLoading(false);
        setActiveEntryKey(null);
        setPanelNavigationEntries(null);
        setMenuPoint(null);
      }, 100);
    },
    onFocus() {
      setIsFocused(true);
    },
    onUpdate({ editor }) {
      const serialized = serializeRichTextDocumentToContent(editor.getJSON());
      lastSerializedValueRef.current = serialized;
      latestOnChangeRef.current(serialized);
    }
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    if (lastSerializedValueRef.current === normalizedValue) {
      return;
    }

    const currentSerialized = serializeRichTextDocumentToContent(
      editor.getJSON()
    );
    if (currentSerialized === normalizedValue) {
      lastSerializedValueRef.current = normalizedValue;
      return;
    }

    editor.commands.setContent(
      parseRichTextContentToDocument(normalizedValue),
      {
        emitUpdate: false
      }
    );
    lastSerializedValueRef.current = normalizedValue;
  }, [editor, normalizedValue]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    if (Object.is(lastFocusSignalRef.current, focusSignal)) {
      return;
    }

    lastFocusSignalRef.current = focusSignal;
    editor.commands.focus("end");
  }, [editor, focusSignal]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(!disabled);
    editor.view.dispatch(
      editor.state.tr.setMeta("richTextEditable", !disabled)
    );
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const updateQueryState = () => {
      const nextQuery = isFocused ? findEditorAtQuery(editor) : null;
      setQuery(nextQuery);
    };

    const updateFocus = () => {
      setIsFocused(editor.isFocused);
      updateQueryState();
    };

    updateQueryState();
    editor.on("selectionUpdate", updateQueryState);
    editor.on("transaction", updateQueryState);
    editor.on("focus", updateFocus);
    editor.on("blur", updateFocus);
    return () => {
      editor.off("selectionUpdate", updateQueryState);
      editor.off("transaction", updateQueryState);
      editor.off("focus", updateFocus);
      editor.off("blur", updateFocus);
    };
  }, [editor, isFocused]);

  useEffect(() => {
    if (!editor || !query || !isFocused || providers.length === 0) {
      setMatches([]);
      setIsLoading(false);
      setActiveEntryKey(null);
      setPanelNavigationEntries(null);
      return;
    }

    if (query.keyword.length < minQueryLength) {
      setMatches([]);
      setIsLoading(false);
      setActiveEntryKey(null);
      setPanelNavigationEntries(null);
      return;
    }

    const abortController = new AbortController();
    setIsLoading(true);

    void queryRichTextAtMatches(registry, {
      abortSignal: abortController.signal,
      keyword: query.keyword,
      maxResults,
      context: createRichTextAtEditorProviderContext(editor)
    })
      .then((nextMatches) => {
        if (abortController.signal.aborted) {
          return;
        }
        setMatches(nextMatches);
        setPanelNavigationEntries(null);
        setActiveEntryKey((current) =>
          resolveRichTextAtEditorActiveEntryKey({
            activeEntryKey: current,
            entries: createRichTextAtEditorMatchEntries(nextMatches)
          })
        );
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [
    editor,
    isFocused,
    maxResults,
    minQueryLength,
    providers.length,
    query,
    registry
  ]);

  useLayoutEffect(() => {
    if (!editor || !query || !isFocused) {
      setMenuPoint(null);
      return;
    }

    const updateMenuPoint = () => {
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      setMenuPoint({
        x: coords.left,
        y: coords.bottom + menuOffset
      });
    };

    updateMenuPoint();
    window.addEventListener("resize", updateMenuPoint);
    window.addEventListener("scroll", updateMenuPoint, {
      capture: true,
      passive: true
    });
    return () => {
      window.removeEventListener("resize", updateMenuPoint);
      window.removeEventListener("scroll", updateMenuPoint, true);
    };
  }, [editor, isFocused, menuOffset, query]);

  const isMenuOpen = isFocused && !!query && (isLoading || matches.length > 0);
  const isEmpty =
    !editor ||
    serializeRichTextDocumentToContent(editor.getJSON()).trim().length === 0;
  const defaultNavigationEntries = useMemo(
    () => createRichTextAtEditorMatchEntries(matches),
    [matches]
  );
  const navigationEntries = panelNavigationEntries ?? defaultNavigationEntries;
  const resolvedActiveEntryKey = resolveRichTextAtEditorActiveEntryKey({
    activeEntryKey,
    entries: navigationEntries
  });

  useEffect(() => {
    if (activeEntryKey !== resolvedActiveEntryKey) {
      setActiveEntryKey(resolvedActiveEntryKey);
    }
  }, [activeEntryKey, resolvedActiveEntryKey]);

  const updateNavigationEntries = useCallback(
    (nextEntries: readonly RichTextAtEditorNavigationEntry[] | null) => {
      setPanelNavigationEntries((current) =>
        haveSameRichTextAtEditorNavigationEntries(current, nextEntries)
          ? current
          : nextEntries
      );
    },
    []
  );
  const updateNavigationMatches = useCallback(
    (nextMatches: readonly RichTextAtQueryMatch[] | null) => {
      updateNavigationEntries(
        nextMatches
          ? nextMatches.map((match) => createRichTextAtEditorMatchEntry(match))
          : null
      );
    },
    [updateNavigationEntries]
  );
  const activeEntry = findRichTextAtEditorNavigationEntry(
    navigationEntries,
    resolvedActiveEntryKey
  );
  const activeMatch = activeEntry?.type === "match" ? activeEntry.match : null;
  const activeIndex = activeMatch
    ? Math.max(
        0,
        matches.findIndex((match) =>
          isSameRichTextAtEditorMatch(match, activeMatch)
        )
      )
    : 0;
  const handleActiveIndexChange = useCallback(
    (index: number) => {
      const match = matches[index];
      setActiveEntryKey(
        match
          ? findRichTextAtEditorEntryKeyForMatch(navigationEntries, match)
          : null
      );
    },
    [matches, navigationEntries]
  );
  const handleActiveMatchChange = useCallback(
    (match: RichTextAtQueryMatch | null) => {
      setActiveEntryKey(
        match
          ? findRichTextAtEditorEntryKeyForMatch(navigationEntries, match)
          : null
      );
    },
    [navigationEntries]
  );

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      setActiveEntryKey((current) =>
        moveRichTextAtEditorActiveEntryKey({
          activeEntryKey: findRichTextAtEditorNavigationEntry(
            navigationEntries,
            current
          )
            ? current
            : resolvedActiveEntryKey,
          delta,
          entries: navigationEntries
        })
      );
    },
    [navigationEntries, resolvedActiveEntryKey]
  );

  const applyMatch = useCallback(
    (match: RichTextAtQueryMatch) => {
      if (!editor || !query) {
        return;
      }

      const content = renderInsertResultAsEditorContent(
        match.providerId,
        match.insertResult
      );
      if (!content) {
        return;
      }

      editor
        .chain()
        .focus()
        .insertContentAt({ from: query.from, to: query.to }, content)
        .run();
      setMatches([]);
      setPanelNavigationEntries(null);
      setActiveEntryKey(null);
      setIsLoading(false);
      setMenuPoint(null);
    },
    [editor, query]
  );

  const closeMenu = useCallback(() => {
    setMatches([]);
    setPanelNavigationEntries(null);
    setActiveEntryKey(null);
    setIsLoading(false);
    setMenuPoint(null);
  }, []);

  const commitActiveEntry = useCallback(() => {
    const entry =
      findRichTextAtEditorNavigationEntry(
        navigationEntries,
        resolvedActiveEntryKey
      ) ??
      navigationEntries[0] ??
      null;
    if (!entry) {
      return;
    }
    if (entry.type === "action") {
      entry.onSelect();
      return;
    }
    applyMatch(entry.match);
  }, [resolvedActiveEntryKey, navigationEntries, applyMatch]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isRichTextImeComposing(event)) {
      return;
    }

    if (!isMenuOpen) {
      return;
    }

    // Tab cycles the filter tabs (parity with the agent composer). Handled
    // before the empty check so it still works while the active tab is empty.
    if (event.key === "Tab" && onCycleFilter) {
      event.preventDefault();
      onCycleFilter(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Enter") {
      if (navigationEntries.length === 0) {
        return;
      }
      event.preventDefault();
      commitActiveEntry();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  return (
    <div
      className={cn("relative min-w-0 w-full", className)}
      ref={containerRef}
    >
      <div className="w-full min-w-0" onKeyDownCapture={handleKeyDown}>
        <EditorContent editor={editor} />
      </div>
      {isEmpty && placeholder ? (
        <div className="pointer-events-none absolute top-0 right-0 left-0 px-0 py-0 text-[var(--text-placeholder)]">
          <div
            className={cn(
              "min-w-0 w-full whitespace-pre-wrap",
              placeholderClassName ?? textareaClassName,
              "text-[var(--text-placeholder)]"
            )}
          >
            {placeholder}
          </div>
        </div>
      ) : null}
      {overlay}
      {isMenuOpen && menuPoint ? (
        <ViewportMenuSurface
          open
          className="tutti-rich-text-at-menu w-[min(28rem,calc(100vw-24px))] p-0"
          placement={{
            type: "point",
            point: menuPoint,
            alignX: "start",
            alignY: "start",
            estimatedSize: {
              width: 360,
              height: 256
            }
          }}
        >
          {renderPanel ? (
            renderPanel({
              activeEntryKey: resolvedActiveEntryKey,
              activeIndex,
              activeMatch,
              isLoading,
              matches,
              maxResults,
              navigationEntries,
              onActiveEntryKeyChange: setActiveEntryKey,
              onActiveIndexChange: handleActiveIndexChange,
              onActiveMatchChange: handleActiveMatchChange,
              onNavigationEntriesChange: updateNavigationEntries,
              onNavigationMatchesChange: updateNavigationMatches,
              onMoveSelection: moveSelection,
              onSelect: applyMatch,
              providerContext: editor
                ? createRichTextAtEditorProviderContext(editor)
                : {},
              providers,
              query,
              text
            })
          ) : (
            <div className="flex max-h-64 min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {matches.length > 0 ? (
                  matches.map((match) => {
                    const entryKey = richTextAtEditorMatchEntryKey(match);
                    const isActive = resolvedActiveEntryKey === entryKey;
                    return (
                      <button
                        key={entryKey}
                        aria-selected={isActive}
                        className={cn(
                          "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors",
                          isActive
                            ? "bg-transparency-block text-[var(--text-primary)]"
                            : "text-[var(--text-primary)] hover:bg-transparency-block"
                        )}
                        type="button"
                        onMouseEnter={() => setActiveEntryKey(entryKey)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applyMatch(match);
                        }}
                      >
                        <div className="text-[13px] leading-5 font-medium">
                          {match.label}
                        </div>
                        {match.subtitle ? (
                          <div className="text-[11px] leading-4 text-[var(--text-secondary)]">
                            {match.subtitle}
                          </div>
                        ) : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-2 text-[11px] leading-4 text-[var(--text-secondary)]">
                    {isLoading ? text.loadingLabel : text.noMatchesLabel}
                  </div>
                )}
              </div>
            </div>
          )}
        </ViewportMenuSurface>
      ) : null}
    </div>
  );
}

function findEditorAtQuery(
  editor: TiptapEditor
): RichTextEditorAtQueryState | null {
  const { selection } = editor.state;
  if (!selection.empty) {
    return null;
  }

  const { $from } = selection;
  if (!$from.parent.isTextblock) {
    return null;
  }

  const textBeforeCursor = $from.parent.textBetween(
    0,
    $from.parentOffset,
    "\n",
    "\uFFFC"
  );
  const query = findRichTextAtQuery(textBeforeCursor, textBeforeCursor.length);
  if (!query) {
    return null;
  }

  const distanceFromQueryStart = textBeforeCursor.length - query.from;
  return {
    from: selection.from - distanceFromQueryStart,
    keyword: query.keyword,
    to: selection.from
  };
}

function createRichTextAtEditorProviderContext(
  editor: TiptapEditor
): RichTextAtProviderContext {
  return {
    blockText: editor.state.selection.$from.parent.textBetween(
      0,
      editor.state.selection.$from.parent.content.size,
      "\n",
      "\uFFFC"
    ),
    documentText: serializeRichTextDocumentToContent(editor.getJSON())
  };
}

function renderInsertResultAsEditorContent(
  providerId: string,
  result: RichTextAtInsertResult
) {
  switch (result.kind) {
    case "mention":
      return {
        type: mentionReferenceNodeName,
        attrs: createRichTextMentionAttrs(providerId, result.mention)
      };
    case "markdown-link": {
      const kind = result.href.endsWith("/") ? "folder" : "file";
      return {
        type: workspaceReferenceNodeName,
        attrs: {
          kind,
          label: result.label,
          path: normalizeRichTextLinkHref(result.href, kind)
        }
      };
    }
    case "text":
      return result.text;
    default:
      return null;
  }
}
