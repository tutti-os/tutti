import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type JSX,
  type KeyboardEvent
} from "react";
import { ViewportMenuSurface } from "@tutti-os/ui-system/components";
import { cn } from "@tutti-os/ui-system/utils";
import { useEffectiveRichTextMentionService } from "./RichTextMentionServiceProvider.tsx";
import { renderRichTextTriggerInsertResult } from "../plugins/trigger.ts";
import type {
  RichTextTriggerProvider,
  RichTextTriggerQueryMatch
} from "../types/trigger.ts";
import type { RichTextMentionService } from "../service/index.ts";
import {
  findRichTextTriggerQuery,
  queryRichTextTriggerMatches
} from "./richTextTriggerQuery.ts";
import { isRichTextImeComposing } from "./richTextIme.ts";
import {
  buildRichTextTextareaDecorationSegments,
  getTextareaPresentationStyle,
  hasRichTextTextareaDecorations,
  resolveRichTextTextareaSelectionBoundary
} from "./richTextTextareaDecorationModel.ts";
import {
  resolveRichTextTriggerText,
  type RichTextTriggerTextOverrides
} from "./richTextTriggerText.ts";
import { RichTextTriggerMenuItem } from "./RichTextTriggerMenuItem.tsx";
import type { RichTextI18nRuntime } from "../i18n/richTextI18n.ts";
import { RichTextTextareaDecoratedContent } from "./richTextTextareaDecorations.tsx";
import { getTextareaCaretViewportPoint } from "./richTextTextareaCaret.ts";
import type { CSSProperties } from "react";

export interface RichTextTriggerTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** @deprecated Prefer mentionService or RichTextMentionServiceProvider. */
  triggerProviders?: readonly RichTextTriggerProvider[];
  mentionService?: RichTextMentionService;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  textareaClassName?: string;
  rows?: number;
  minQueryLength?: number;
  maxResults?: number;
  removeDecorationAriaLabel?: string;
  i18n?: RichTextI18nRuntime;
  textOverrides?: RichTextTriggerTextOverrides;
  overlay?: ReactNode;
}

export function RichTextTriggerTextarea({
  value,
  onChange,
  triggerProviders,
  mentionService,
  placeholder,
  disabled = false,
  className,
  textareaClassName,
  rows,
  minQueryLength = 0,
  maxResults,
  removeDecorationAriaLabel,
  i18n,
  textOverrides,
  overlay
}: RichTextTriggerTextareaProps): JSX.Element {
  const menuOffset = 6;
  const text = resolveRichTextTriggerText(
    textOverrides,
    removeDecorationAriaLabel,
    i18n
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [selectionStart, setSelectionStart] = useState(0);
  const [matches, setMatches] = useState<readonly RichTextTriggerQueryMatch[]>(
    []
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(
    null
  );
  const [scrollPosition, setScrollPosition] = useState({ left: 0, top: 0 });
  const [textareaPresentationStyle, setTextareaPresentationStyle] =
    useState<CSSProperties | null>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const suppressPastedAtQueryRef = useRef(false);
  const registry = useEffectiveRichTextMentionService({
    mentionService,
    triggerProviders
  });
  const activeTriggerConfigs = useMemo(
    () => registry.listTriggerConfigs(),
    [registry]
  );
  const decorationSegments = useMemo(
    () => buildRichTextTextareaDecorationSegments(value),
    [value]
  );
  const hasDecorations = hasRichTextTextareaDecorations(decorationSegments);
  const query = useMemo(
    () =>
      isFocused
        ? findRichTextTriggerQuery(value, selectionStart, activeTriggerConfigs)
        : null,
    [activeTriggerConfigs, isFocused, selectionStart, value]
  );
  const visibleQuery =
    suppressPastedAtQueryRef.current &&
    query?.trigger === "@" &&
    query.keyword.length > 0
      ? null
      : query;
  const shouldQuery =
    visibleQuery !== null &&
    visibleQuery.keyword.length >= minQueryLength &&
    activeTriggerConfigs.length > 0;
  const isMenuOpen =
    isFocused && shouldQuery && (isLoading || matches.length > 0);

  useEffect(() => {
    const nextSelection = pendingSelectionRef.current;
    if (nextSelection === null || !textareaRef.current) {
      return;
    }
    textareaRef.current.setSelectionRange(nextSelection, nextSelection);
    pendingSelectionRef.current = null;
  }, [value]);

  useEffect(() => {
    if (!shouldQuery || !visibleQuery) {
      setMatches([]);
      setActiveIndex(0);
      setIsLoading(false);
      return;
    }

    const abortController = new AbortController();
    setIsLoading(true);

    void queryRichTextTriggerMatches(registry, {
      abortSignal: abortController.signal,
      keyword: visibleQuery.keyword,
      maxResults,
      trigger: visibleQuery.trigger,
      context: {
        documentText: value,
        blockText: value
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
  }, [maxResults, registry, shouldQuery, value, visibleQuery]);

  useLayoutEffect(() => {
    if (!textareaRef.current || !hasDecorations) {
      setTextareaPresentationStyle(null);
      return;
    }

    const textarea = textareaRef.current;
    setTextareaPresentationStyle(getTextareaPresentationStyle(textarea));
    setScrollPosition({
      left: textarea.scrollLeft,
      top: textarea.scrollTop
    });
  }, [hasDecorations, textareaClassName, value]);

  useLayoutEffect(() => {
    if (!isMenuOpen || !visibleQuery || !textareaRef.current) {
      setMenuPoint(null);
      return;
    }

    const caretPoint = getTextareaCaretViewportPoint(
      textareaRef.current,
      visibleQuery.to
    );
    const textareaRect = textareaRef.current.getBoundingClientRect();

    if (!caretPoint) {
      setMenuPoint({
        x: textareaRect.left + 12,
        y: textareaRect.bottom + menuOffset
      });
      return;
    }

    setMenuPoint({
      x: caretPoint.x,
      y: caretPoint.y + caretPoint.lineHeight + menuOffset
    });
  }, [isMenuOpen, menuOffset, selectionStart, value, visibleQuery]);

  useEffect(() => {
    if (!isMenuOpen || !visibleQuery || !textareaRef.current) {
      return;
    }

    const textarea = textareaRef.current;
    const updateMenuPoint = () => {
      const caretPoint = getTextareaCaretViewportPoint(
        textarea,
        visibleQuery.to
      );
      const textareaRect = textarea.getBoundingClientRect();

      setMenuPoint(
        caretPoint
          ? {
              x: caretPoint.x,
              y: caretPoint.y + caretPoint.lineHeight + menuOffset
            }
          : {
              x: textareaRect.left + 12,
              y: textareaRect.bottom + menuOffset
            }
      );
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updateMenuPoint();
          });
    resizeObserver?.observe(textarea);
    textarea.addEventListener("scroll", updateMenuPoint, { passive: true });
    window.addEventListener("resize", updateMenuPoint);
    window.addEventListener("scroll", updateMenuPoint, {
      capture: true,
      passive: true
    });

    return () => {
      resizeObserver?.disconnect();
      textarea.removeEventListener("scroll", updateMenuPoint);
      window.removeEventListener("resize", updateMenuPoint);
      window.removeEventListener("scroll", updateMenuPoint, true);
    };
  }, [isMenuOpen, menuOffset, visibleQuery]);

  const closeMenu = () => {
    setMatches([]);
    setActiveIndex(0);
    setIsLoading(false);
    setMenuPoint(null);
  };

  const setSelection = (nextSelection: number) => {
    pendingSelectionRef.current = nextSelection;
    setSelectionStart(nextSelection);
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextSelection, nextSelection);
      pendingSelectionRef.current = null;
    }
  };

  const handleClickDecoration = (
    segment: Extract<(typeof decorationSegments)[number], { type: "link" }>,
    event: PointerEvent<HTMLSpanElement>
  ) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextSelection =
      event.clientX < bounds.left + bounds.width / 2
        ? segment.from
        : segment.to;
    setSelection(nextSelection);
  };

  const handleRemoveDecoration = (
    segment: Extract<(typeof decorationSegments)[number], { type: "link" }>
  ) => {
    const nextValue = `${value.slice(0, segment.from)}${value.slice(segment.to)}`;
    const nextSelection = Math.min(segment.from, nextValue.length);
    pendingSelectionRef.current = nextSelection;
    onChange(nextValue);
    setSelectionStart(nextSelection);
    window.requestAnimationFrame(() => {
      if (!textareaRef.current) {
        return;
      }
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextSelection, nextSelection);
      pendingSelectionRef.current = null;
    });
  };

  const applyMatch = (match: RichTextTriggerQueryMatch) => {
    const currentQuery = findRichTextTriggerQuery(
      value,
      textareaRef.current?.selectionStart ?? selectionStart,
      activeTriggerConfigs
    );
    if (!currentQuery) {
      return;
    }
    const insertedValue = renderRichTextTriggerInsertResult(
      match.providerId,
      match.insertResult
    );
    const nextValue = `${value.slice(0, currentQuery.from)}${insertedValue}${value.slice(currentQuery.to)}`;
    const nextSelection = currentQuery.from + insertedValue.length;
    pendingSelectionRef.current = nextSelection;
    onChange(nextValue);
    closeMenu();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isRichTextImeComposing(event)) {
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

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  };

  return (
    <div className={cn("relative min-w-0 w-full", className)}>
      {hasDecorations && textareaPresentationStyle ? (
        <RichTextTextareaDecoratedContent
          onClickSegment={handleClickDecoration}
          onRemoveSegment={handleRemoveDecoration}
          removeActionAriaLabel={text.removeReferenceActionLabel}
          scrollLeft={scrollPosition.left}
          scrollTop={scrollPosition.top}
          segments={decorationSegments}
          textareaStyle={textareaPresentationStyle}
        />
      ) : null}
      <textarea
        ref={textareaRef}
        className={textareaClassName}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        style={
          hasDecorations
            ? {
                WebkitTextFillColor: "transparent",
                caretColor: "var(--text-primary)",
                color: "transparent",
                position: "relative",
                zIndex: 0
              }
            : undefined
        }
        value={value}
        onBlur={() => {
          window.setTimeout(() => {
            setIsFocused(false);
            closeMenu();
          }, 100);
        }}
        onPaste={(event) => {
          const pastedText = event.clipboardData.getData("text/plain");
          suppressPastedAtQueryRef.current =
            pastedText.includes("@") && !pastedText.endsWith("@");
          if (suppressPastedAtQueryRef.current) {
            window.setTimeout(() => {
              suppressPastedAtQueryRef.current = false;
            }, 0);
          }
        }}
        onChange={(event) => {
          const rawSelectionStart = event.target.selectionStart ?? 0;
          const nextSelection =
            resolveRichTextTextareaSelectionBoundary(
              decorationSegments,
              rawSelectionStart
            ) ?? rawSelectionStart;
          if (nextSelection !== rawSelectionStart) {
            event.target.setSelectionRange(nextSelection, nextSelection);
          }
          setSelectionStart(nextSelection);
          onChange(event.target.value);
        }}
        onFocus={(event) => {
          setIsFocused(true);
          const rawSelectionStart = event.target.selectionStart ?? 0;
          const nextSelection =
            resolveRichTextTextareaSelectionBoundary(
              decorationSegments,
              rawSelectionStart
            ) ?? rawSelectionStart;
          if (nextSelection !== rawSelectionStart) {
            event.target.setSelectionRange(nextSelection, nextSelection);
          }
          setSelectionStart(nextSelection);
          setScrollPosition({
            left: event.target.scrollLeft,
            top: event.target.scrollTop
          });
        }}
        onKeyDown={handleKeyDown}
        onScroll={(event) => {
          setScrollPosition({
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop
          });
        }}
        onSelect={(event) => {
          const rawSelectionStart = event.currentTarget.selectionStart ?? 0;
          const nextSelection =
            resolveRichTextTextareaSelectionBoundary(
              decorationSegments,
              rawSelectionStart
            ) ?? rawSelectionStart;
          if (nextSelection !== rawSelectionStart) {
            event.currentTarget.setSelectionRange(nextSelection, nextSelection);
          }
          setSelectionStart(nextSelection);
        }}
      />
      {overlay}
      {isMenuOpen && menuPoint ? (
        <ViewportMenuSurface
          open
          className="tutti-rich-text-at-menu max-h-64 w-[min(28rem,calc(100vw-24px))] overflow-y-auto p-1"
          dismissIgnoreRefs={[textareaRef]}
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
          {matches.length > 0 ? (
            matches.map((match, index) => (
              <RichTextTriggerMenuItem
                key={`${match.providerId}:${match.key}`}
                label={match.label}
                selected={index === activeIndex}
                subtitle={match.subtitle}
                iconUrl={match.iconUrl}
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
