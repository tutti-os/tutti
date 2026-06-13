import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type MutableRefObject
} from "react";

export interface StreamingVisibleTextOptions {
  enabled: boolean;
  frameMs?: number;
  maxCharsPerSecond?: number;
  trailingFlushChars?: number;
}

const DEFAULT_FRAME_MS = 24;
const DEFAULT_MAX_CHARS_PER_SECOND = 6_000;
const DEFAULT_TRAILING_FLUSH_CHARS = 0;

export function useStreamingVisibleText(
  sourceText: string,
  options: StreamingVisibleTextOptions
): string {
  const {
    enabled,
    frameMs = DEFAULT_FRAME_MS,
    maxCharsPerSecond = DEFAULT_MAX_CHARS_PER_SECOND,
    trailingFlushChars = DEFAULT_TRAILING_FLUSH_CHARS
  } = options;
  const [visibleText, setVisibleText] = useState(sourceText);
  const sourceRef = useRef(sourceText);
  const visibleRef = useRef(visibleText);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    visibleRef.current = visibleText;
  }, [visibleText]);

  useEffect(
    () => () => {
      clearStreamingVisibleTextTimer(timerRef);
    },
    []
  );

  useEffect(() => {
    sourceRef.current = sourceText;

    if (!enabled) {
      clearStreamingVisibleTextTimer(timerRef);
      visibleRef.current = sourceText;
      setVisibleText(sourceText);
      return;
    }

    if (sourceText === visibleRef.current || timerRef.current !== null) {
      return;
    }

    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        const nextVisibleText = advanceStreamingVisibleText({
          visibleText: visibleRef.current,
          sourceText: sourceRef.current,
          frameMs,
          maxCharsPerSecond,
          trailingFlushChars
        });

        if (nextVisibleText === visibleRef.current) {
          return;
        }

        visibleRef.current = nextVisibleText;
        startTransition(() => {
          setVisibleText(nextVisibleText);
        });
      },
      Math.max(1, frameMs)
    );

    return undefined;
  }, [
    enabled,
    frameMs,
    maxCharsPerSecond,
    sourceText,
    trailingFlushChars,
    visibleText
  ]);

  return enabled ? visibleText : sourceText;
}

export function advanceStreamingVisibleText({
  visibleText,
  sourceText,
  frameMs = DEFAULT_FRAME_MS,
  maxCharsPerSecond = DEFAULT_MAX_CHARS_PER_SECOND,
  trailingFlushChars = DEFAULT_TRAILING_FLUSH_CHARS
}: {
  visibleText: string;
  sourceText: string;
  frameMs?: number;
  maxCharsPerSecond?: number;
  trailingFlushChars?: number;
}): string {
  if (visibleText === sourceText) {
    return visibleText;
  }

  const prefixLength = sourceText.startsWith(visibleText)
    ? visibleText.length
    : commonPrefixLength(visibleText, sourceText);
  const stablePrefix = sourceText.slice(0, prefixLength);
  const remainingLength = sourceText.length - prefixLength;
  if (remainingLength <= trailingFlushChars) {
    return sourceText;
  }

  const charsPerFrame = Math.max(
    1,
    Math.ceil((Math.max(1, maxCharsPerSecond) * Math.max(1, frameMs)) / 1000)
  );
  return sourceText.slice(
    0,
    Math.min(sourceText.length, stablePrefix.length + charsPerFrame)
  );
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (left.charCodeAt(index) !== right.charCodeAt(index)) {
      return index;
    }
  }
  return maxLength;
}

function clearStreamingVisibleTextTimer(
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
): void {
  if (timerRef.current === null) {
    return;
  }
  clearTimeout(timerRef.current);
  timerRef.current = null;
}
