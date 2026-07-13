import {
  startTransition,
  useEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from "react";

const COLLAPSED_LINE_LIMIT = 8;
const APPROX_CHARS_PER_LINE = 34;
const DEFERRED_LONG_MARKDOWN_FALLBACK_DELAY_MS = 80;
const DEFERRED_LONG_MARKDOWN_IDLE_TIMEOUT_MS = 700;

export interface StreamingMarkdownBlock {
  content: string;
  initialKeyContent: string;
}

export function splitStreamingMarkdownBlocks(
  content: string
): StreamingMarkdownBlock[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return [{ content: "", initialKeyContent: "" }];
  }

  const lines = normalized.split("\n");
  const blocks: StreamingMarkdownBlock[] = [];
  const current: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    current.push(line);
    const lineFence = parseStreamingFence(line);
    if (lineFence) {
      if (!fence) {
        fence = lineFence;
      } else if (
        lineFence.marker === fence.marker &&
        lineFence.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (!fence && line.trim() === "") {
      pushStreamingMarkdownBlock(blocks, current);
    }
  }
  pushStreamingMarkdownBlock(blocks, current);
  return blocks.length > 0
    ? blocks
    : [{ content: normalized, initialKeyContent: normalized }];
}

export function pushStreamingMarkdownBlock(
  blocks: StreamingMarkdownBlock[],
  lines: string[]
): void {
  if (lines.length === 0) {
    return;
  }
  const content = lines.join("\n");
  if (!content) {
    lines.length = 0;
    return;
  }
  blocks.push({
    content,
    initialKeyContent: content
  });
  lines.length = 0;
}

export function parseStreamingFence(
  line: string
): { marker: string; length: number } | null {
  const trimmed = line.trimStart();
  const marker = trimmed[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  let length = 0;
  while (trimmed[length] === marker) {
    length += 1;
  }
  return length >= 3 ? { marker, length } : null;
}

export function resolveMarkdownAnchorHref(
  target: EventTarget | null
): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const link = target.closest("[data-agent-link-href],a[href]");
  if (!(link instanceof HTMLElement)) {
    return null;
  }
  const dataHref = link.dataset.agentLinkHref?.trim();
  if (dataHref) {
    return dataHref;
  }
  if (link instanceof HTMLAnchorElement) {
    return link.getAttribute("href")?.trim() || null;
  }
  return null;
}

export function activateMarkdownLink(
  event:
    | KeyboardEvent<HTMLElement>
    | MouseEvent<HTMLElement>
    | PointerEvent<HTMLElement>,
  href: string,
  onLinkClick?: (href: string) => void
): void {
  const target = href.trim();
  if (!target) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  onLinkClick?.(target);
}

export function activateMarkdownLinkFromKey(
  event: KeyboardEvent<HTMLElement>,
  href: string,
  onLinkClick?: (href: string) => void
): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  activateMarkdownLink(event, href, onLinkClick);
}

export function activateMarkdownLinkFromPointer(
  event: PointerEvent<HTMLElement>,
  href: string,
  onLinkClick?: (href: string) => void
): void {
  if (event.button !== 0) {
    return;
  }
  activateMarkdownLink(event, href, onLinkClick);
}

export function useDeferredMarkdownRenderReady(
  contentSignature: string,
  shouldDefer: boolean
): boolean {
  const [readySignature, setReadySignature] = useState<string | null>(
    shouldDefer ? null : contentSignature
  );
  const renderReady = !shouldDefer || readySignature === contentSignature;

  useEffect(() => {
    if (!shouldDefer) {
      setReadySignature(contentSignature);
      return;
    }

    let canceled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleCallbackId: number | null = null;
    const markReady = (): void => {
      if (canceled) {
        return;
      }
      startTransition(() => {
        setReadySignature(contentSignature);
      });
    };

    if ("requestIdleCallback" in window) {
      idleCallbackId = window.requestIdleCallback(markReady, {
        timeout: DEFERRED_LONG_MARKDOWN_IDLE_TIMEOUT_MS
      });
    } else {
      // timing: requestIdleCallback fallback for runtimes that lack it
      timeoutId = setTimeout(
        markReady,
        DEFERRED_LONG_MARKDOWN_FALLBACK_DELAY_MS
      );
    }

    return () => {
      canceled = true;
      if (idleCallbackId !== null) {
        window.cancelIdleCallback(idleCallbackId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [contentSignature, shouldDefer]);

  return renderReady;
}

export function hashMarkdownProfilerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }
  return `${content.length}:${Math.abs(hash)}`;
}

export function isLikelyLongerThanLineLimit(content: string): boolean {
  const normalizedLines = content.replace(/\r\n?/g, "\n").split("\n");
  if (normalizedLines.length > COLLAPSED_LINE_LIMIT) {
    return true;
  }
  const estimatedLineCount = normalizedLines.reduce((total, line) => {
    const trimmed = line.trim();
    const blockSpacing = /^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>)/.test(trimmed)
      ? 1
      : 0;
    return (
      total +
      Math.max(1, Math.ceil(trimmed.length / APPROX_CHARS_PER_LINE)) +
      blockSpacing
    );
  }, 0);
  return estimatedLineCount > COLLAPSED_LINE_LIMIT;
}
