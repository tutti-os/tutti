import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
import { createRichTextTriggerRegistry } from "../plugins/triggerRegistry.ts";
import type {
  RichTextMentionAttrs,
  RichTextMentionPresentation
} from "../types/mention.ts";
import type {
  RichTextTriggerInsertResult,
  RichTextTriggerProvider,
  RichTextTriggerQueryMatch,
  RichTextTrigger,
  RichTextTriggerConfig
} from "../types/trigger.ts";
import {
  normalizeRichTextContent,
  normalizeRichTextLinkHref,
  parseRichTextContentToDocument,
  serializeRichTextDocumentToContent
} from "../core/richTextDocument.ts";
import {
  findRichTextTriggerQuery,
  queryRichTextTriggerMatches
} from "./richTextTriggerQuery.ts";
import { isRichTextImeComposing } from "./richTextIme.ts";
import {
  resolveRichTextTriggerText,
  type RichTextTriggerTextOverrides
} from "./richTextTriggerText.ts";
import {
  resolveRichTextTriggerMenuPlacement,
  richTextTriggerMenuEstimatedSize,
  type RichTextTriggerMenuAnchor,
  type RichTextTriggerMenuPlacement,
  type RichTextTriggerResolvedMenuPlacement
} from "./richTextTriggerMenuPlacement.ts";
import { RichTextTriggerMenuItem } from "./RichTextTriggerMenuItem.tsx";
import type { RichTextI18nRuntime } from "../i18n/richTextI18n.ts";
import { MentionReference } from "../extensions/mentionReference.ts";
import { WorkspaceReference } from "../extensions/workspaceReference.ts";
import {
  mentionReferenceNodeName,
  workspaceReferenceNodeName
} from "../extensions/names.ts";

export interface RichTextTriggerEditorProps {
  value: string;
  onChange: (value: string) => void;
  triggerProviders?: readonly RichTextTriggerProvider[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  textareaClassName?: string;
  placeholderClassName?: string;
  minQueryLength?: number;
  maxResults?: number;
  removeDecorationAriaLabel?: string;
  i18n?: RichTextI18nRuntime;
  textOverrides?: RichTextTriggerTextOverrides;
  overlay?: ReactNode;
  focusSignal?: unknown;
  menuAnchor?: RichTextTriggerMenuAnchor;
  menuPlacement?: RichTextTriggerMenuPlacement;
  menuOffset?: number;
  menuZIndex?: string | number;
}

type RichTextEditorTriggerQueryState = {
  from: number;
  keyword: string;
  trigger: RichTextTrigger;
  to: number;
};

const RICH_TEXT_MENTION_PRESENTATION_KEYS = [
  "agentProviderId",
  "agentIconUrl",
  "iconUrl",
  "thumbnailUrl",
  "subtitle",
  "description",
  "participant",
  "status",
  "statusDataStatus",
  "statusLabel",
  "statusPulse",
  "userAvatarPlaceholderUrl"
] as const satisfies readonly (keyof RichTextMentionPresentation)[];

export function RichTextTriggerEditor({
  value,
  onChange,
  triggerProviders = [],
  placeholder,
  disabled = false,
  className,
  textareaClassName,
  placeholderClassName,
  minQueryLength = 0,
  maxResults,
  removeDecorationAriaLabel,
  i18n,
  textOverrides,
  overlay,
  focusSignal,
  menuAnchor = "cursor",
  menuPlacement = "bottom-start",
  menuOffset = 6,
  menuZIndex
}: RichTextTriggerEditorProps): JSX.Element {
  const normalizedValue = normalizeRichTextContent(value);
  const text = resolveRichTextTriggerText(
    textOverrides,
    removeDecorationAriaLabel,
    i18n
  );
  const latestOnChangeRef = useRef(onChange);
  const lastSerializedValueRef = useRef(normalizedValue);
  const lastFocusSignalRef = useRef(focusSignal);
  const mentionHydrationRequestRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const registry = useMemo(
    () => createRichTextTriggerRegistry(triggerProviders),
    [triggerProviders]
  );
  const activeTriggerConfigs = useMemo(
    () => registry.listTriggerConfigs(),
    [registry]
  );
  const [isFocused, setIsFocused] = useState(false);
  const [query, setQuery] = useState<RichTextEditorTriggerQueryState | null>(
    null
  );
  const [matches, setMatches] = useState<readonly RichTextTriggerQueryMatch[]>(
    []
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [resolvedMenuAnchor, setResolvedMenuAnchor] =
    useState<RichTextTriggerResolvedMenuPlacement | null>(null);

  latestOnChangeRef.current = onChange;

  const resetMenuPlacement = useCallback(() => {
    setResolvedMenuAnchor(null);
  }, []);

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
        setQuery(null);
        setMatches([]);
        setActiveIndex(0);
        setIsLoading(false);
        resetMenuPlacement();
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

    const requestId = mentionHydrationRequestRef.current + 1;
    mentionHydrationRequestRef.current = requestId;
    const mentions = collectHydratableMentionNodes(editor);
    if (mentions.length === 0) {
      return;
    }

    for (const mention of mentions) {
      const provider = registry.getProvider(mention.attrs.providerId);
      if (!provider?.resolveMention) {
        continue;
      }

      void Promise.resolve(provider.resolveMention(mention.attrs))
        .then((resolved) => {
          if (
            !resolved ||
            mentionHydrationRequestRef.current !== requestId ||
            editor.isDestroyed
          ) {
            return;
          }

          applyResolvedMentionAttrs(editor, mention.pos, mention.attrs, {
            label: resolved.label,
            presentation: resolved.presentation
          });
        })
        .catch(() => {
          // Resolver failures keep the fallback label-only mention.
        });
    }
  }, [editor, registry, normalizedValue]);

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
      const nextQuery = findEditorAtQuery(editor, activeTriggerConfigs);
      setQuery(nextQuery);
    };

    const updateFocus = () => {
      const nextFocused = editor.isFocused;
      setIsFocused(nextFocused);
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
  }, [activeTriggerConfigs, editor]);

  useEffect(() => {
    if (!editor || !query || activeTriggerConfigs.length === 0) {
      setMatches([]);
      setActiveIndex(0);
      setIsLoading(false);
      return;
    }

    if (query.keyword.length < minQueryLength) {
      setMatches([]);
      setActiveIndex(0);
      setIsLoading(false);
      return;
    }

    const abortController = new AbortController();
    setIsLoading(true);

    void queryRichTextTriggerMatches(registry, {
      abortSignal: abortController.signal,
      keyword: query.keyword,
      maxResults,
      trigger: query.trigger,
      context: {
        blockText: editor.state.selection.$from.parent.textBetween(
          0,
          editor.state.selection.$from.parent.content.size,
          "\n",
          "\uFFFC"
        ),
        documentText: serializeRichTextDocumentToContent(editor.getJSON())
      }
    })
      .then((nextMatches) => {
        if (abortController.signal.aborted) {
          return;
        }
        setMatches(nextMatches);
        setActiveIndex((current) =>
          nextMatches.length === 0
            ? 0
            : Math.max(0, Math.min(current, nextMatches.length - 1))
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
    maxResults,
    minQueryLength,
    activeTriggerConfigs.length,
    query,
    registry
  ]);

  useLayoutEffect(() => {
    if (!editor || !query) {
      resetMenuPlacement();
      return;
    }

    const updateMenuAnchor = () => {
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      const editorRect = editor.view.dom.getBoundingClientRect();
      const nextMenuAnchor = resolveRichTextTriggerMenuPlacement({
        cursorRect: coords,
        editorRect,
        menuAnchor,
        menuOffset,
        menuPlacement,
        viewportWidth: typeof window === "undefined" ? 1280 : window.innerWidth,
        viewportHeight: typeof window === "undefined" ? 720 : window.innerHeight
      });
      setResolvedMenuAnchor(nextMenuAnchor);
    };

    updateMenuAnchor();
    window.addEventListener("resize", updateMenuAnchor);
    window.addEventListener("scroll", updateMenuAnchor, {
      capture: true,
      passive: true
    });
    return () => {
      window.removeEventListener("resize", updateMenuAnchor);
      window.removeEventListener("scroll", updateMenuAnchor, true);
    };
  }, [
    editor,
    menuAnchor,
    menuOffset,
    menuPlacement,
    query,
    resetMenuPlacement
  ]);

  const canQueryTrigger =
    !!query &&
    activeTriggerConfigs.length > 0 &&
    query.keyword.length >= minQueryLength;
  const isMenuOpen = canQueryTrigger && (isFocused || !!resolvedMenuAnchor);
  const isEmpty =
    !editor ||
    serializeRichTextDocumentToContent(editor.getJSON()).trim().length === 0;
  const menuSurfaceStyle = resolveMenuSurfaceStyle(
    resolvedMenuAnchor,
    menuZIndex
  );

  const applyMatch = (match: RichTextTriggerQueryMatch) => {
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
    setActiveIndex(0);
    setIsLoading(false);
    resetMenuPlacement();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isRichTextImeComposing(event)) {
      return;
    }

    if (!isMenuOpen) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setMatches([]);
      setActiveIndex(0);
      setIsLoading(false);
      resetMenuPlacement();
      return;
    }

    if (matches.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % matches.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (current) => (current - 1 + matches.length) % matches.length
      );
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      const match = matches[activeIndex];
      if (!match) {
        return;
      }
      event.preventDefault();
      applyMatch(match);
      return;
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
      {isMenuOpen && resolvedMenuAnchor ? (
        <ViewportMenuSurface
          open
          className="tutti-rich-text-at-menu max-h-64 w-[min(28rem,calc(100vw-24px))] overflow-y-auto p-1"
          placement={resolveViewportMenuSurfacePlacement(resolvedMenuAnchor)}
          style={menuSurfaceStyle}
        >
          {matches.length > 0 ? (
            matches.map((match, index) => (
              <RichTextTriggerMenuItem
                key={`${match.providerId}:${match.key}`}
                label={match.label}
                selected={index === activeIndex}
                subtitle={match.subtitle}
                iconUrl={match.iconUrl}
                workspaceReferenceFileKind={getWorkspaceReferenceFileKind(
                  match.insertResult
                )}
                onSelect={() => applyMatch(match)}
              />
            ))
          ) : (
            <div className="px-3 py-2 text-[11px] leading-4 text-[var(--text-secondary)]">
              {isLoading ? text.loadingLabel : text.noMatchesLabel}
            </div>
          )}
        </ViewportMenuSurface>
      ) : null}
    </div>
  );
}

function resolveViewportMenuSurfacePlacement(
  menuAnchor: RichTextTriggerResolvedMenuPlacement
) {
  return {
    type: "point" as const,
    ...(menuAnchor.boundaryPoint
      ? { boundaryPoint: menuAnchor.boundaryPoint }
      : {}),
    point: menuAnchor.point,
    alignX: "start" as const,
    alignY: menuAnchor.alignY,
    estimatedSize: {
      width: menuAnchor.width ?? richTextTriggerMenuEstimatedSize.width,
      height: richTextTriggerMenuEstimatedSize.height
    }
  };
}

function resolveMenuSurfaceStyle(
  menuAnchor: RichTextTriggerResolvedMenuPlacement | null,
  menuZIndex: string | number | undefined
): CSSProperties | undefined {
  if (!menuAnchor && menuZIndex === undefined) {
    return undefined;
  }

  return {
    ...(menuAnchor?.width !== undefined
      ? {
          width: menuAnchor.width,
          maxWidth: menuAnchor.width
        }
      : {}),
    ...(menuZIndex === undefined ? {} : { zIndex: menuZIndex })
  };
}

function findEditorAtQuery(
  editor: TiptapEditor,
  triggers: readonly RichTextTriggerConfig[]
): RichTextEditorTriggerQueryState | null {
  const query = findEditorTriggerQuery(editor, triggers);
  if (!query) {
    return null;
  }
  return query;
}

function findEditorTriggerQuery(
  editor: TiptapEditor,
  triggers: readonly RichTextTriggerConfig[]
): RichTextEditorTriggerQueryState | null {
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
  const query = findRichTextTriggerQuery(
    textBeforeCursor,
    textBeforeCursor.length,
    triggers
  );
  if (!query) {
    return null;
  }

  const distanceFromQueryStart = textBeforeCursor.length - query.from;
  return {
    from: selection.from - distanceFromQueryStart,
    keyword: query.keyword,
    trigger: query.trigger,
    to: selection.from
  };
}

function renderInsertResultAsEditorContent(
  providerId: string,
  result: RichTextTriggerInsertResult
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

function getWorkspaceReferenceFileKind(
  result: RichTextTriggerInsertResult
): "file" | "folder" | undefined {
  if (result.kind !== "markdown-link") {
    return undefined;
  }
  return result.href.endsWith("/") ? "folder" : "file";
}

function collectHydratableMentionNodes(
  editor: TiptapEditor
): Array<{ attrs: RichTextMentionAttrs; pos: number }> {
  const mentions: Array<{ attrs: RichTextMentionAttrs; pos: number }> = [];

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== mentionReferenceNodeName) {
      return;
    }
    const attrs = node.attrs as Partial<RichTextMentionAttrs>;
    if (
      attrs.trigger !== "@" ||
      typeof attrs.providerId !== "string" ||
      !attrs.providerId.trim() ||
      typeof attrs.entityId !== "string" ||
      !attrs.entityId.trim() ||
      typeof attrs.label !== "string" ||
      !attrs.label.trim()
    ) {
      return;
    }

    mentions.push({
      pos,
      attrs: {
        trigger: "@",
        providerId: attrs.providerId.trim(),
        entityId: attrs.entityId.trim(),
        label: attrs.label.trim().replace(/^@+/, "").trim(),
        scope: normalizeMentionStringRecord(attrs.scope),
        presentation: normalizeMentionPresentation(attrs.presentation)
      }
    });
  });

  return mentions;
}

function applyResolvedMentionAttrs(
  editor: TiptapEditor,
  pos: number,
  currentAttrs: RichTextMentionAttrs,
  resolved: {
    label?: string;
    presentation?: RichTextMentionPresentation;
  }
): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== mentionReferenceNodeName) {
    return;
  }

  const attrs = node.attrs as Partial<RichTextMentionAttrs>;
  if (
    attrs.providerId !== currentAttrs.providerId ||
    attrs.entityId !== currentAttrs.entityId ||
    JSON.stringify(normalizeMentionStringRecord(attrs.scope) ?? {}) !==
      JSON.stringify(currentAttrs.scope ?? {})
  ) {
    return;
  }

  const nextLabel = resolved.label?.trim().replace(/^@+/, "").trim();
  const nextPresentation = normalizeMentionPresentation(resolved.presentation);
  const nextAttrs: RichTextMentionAttrs = {
    trigger: "@",
    providerId: currentAttrs.providerId,
    entityId: currentAttrs.entityId,
    label: nextLabel || currentAttrs.label,
    scope: currentAttrs.scope,
    presentation: nextPresentation ?? currentAttrs.presentation
  };

  if (
    attrs.label === nextAttrs.label &&
    JSON.stringify(normalizeMentionPresentation(attrs.presentation) ?? {}) ===
      JSON.stringify(nextAttrs.presentation ?? {})
  ) {
    return;
  }

  const transaction = editor.state.tr.setNodeMarkup(pos, undefined, nextAttrs);
  transaction.setMeta("addToHistory", false);
  transaction.setMeta("preventUpdate", true);
  editor.view.dispatch(transaction);
}

function normalizeMentionStringRecord(
  value: unknown
): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(
      ([key, entryValue]) =>
        [
          key.trim(),
          typeof entryValue === "string" ? entryValue.trim() : ""
        ] as const
    )
    .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length > 0
    ? Object.freeze(Object.fromEntries(entries))
    : undefined;
}

function normalizeMentionPresentation(
  value: unknown
): RichTextMentionPresentation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<keyof RichTextMentionPresentation, unknown>;
  const next: RichTextMentionPresentation = {};

  for (const key of RICH_TEXT_MENTION_PRESENTATION_KEYS) {
    const fieldValue = source[key];
    if (typeof fieldValue !== "string") {
      continue;
    }
    const trimmed = fieldValue.trim();
    if (trimmed) {
      next[key] = trimmed;
    }
  }

  return Object.keys(next).length > 0 ? Object.freeze(next) : undefined;
}
