import type { JSX, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "#lib/utils";

export interface SegmentBarItem<TValue extends string> {
  value: TValue;
  label: ReactNode;
  testId?: string;
}

interface SegmentBarProps<TValue extends string> {
  segments: ReadonlyArray<SegmentBarItem<TValue>>;
  value: TValue;
  onValueChange: (value: TValue) => void;
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

/**
 * Segmented control with a sliding active pill. Generic over the segment
 * value type so callers stay type-safe for any number of segments.
 */
function SegmentBar<TValue extends string>({
  segments,
  value,
  onValueChange,
  ariaLabel,
  className,
  testId
}: SegmentBarProps<TValue>): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Partial<Record<TValue, HTMLButtonElement>>>({});
  const [indicator, setIndicator] = useState({
    left: 0,
    width: 0,
    ready: false
  });

  useLayoutEffect(() => {
    const button = buttonRefs.current[value];
    if (!button) {
      setIndicator((current) =>
        current.ready ? current : { ...current, ready: false }
      );
      return;
    }
    const next = {
      left: button.offsetLeft,
      width: button.offsetWidth,
      ready: true
    };
    setIndicator((current) =>
      current.left === next.left &&
      current.width === next.width &&
      current.ready === next.ready
        ? current
        : next
    );
  }, [segments, value]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const sync = (): void => {
      const button = buttonRefs.current[value];
      if (!button) {
        return;
      }
      setIndicator((current) =>
        current.left === button.offsetLeft &&
        current.width === button.offsetWidth
          ? current
          : {
              left: button.offsetLeft,
              width: button.offsetWidth,
              ready: true
            }
      );
    };
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    for (const key of Object.keys(buttonRefs.current) as TValue[]) {
      const node = buttonRefs.current[key];
      if (node) {
        observer.observe(node);
      }
    }
    return () => observer.disconnect();
  }, [segments, value]);

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-[var(--transparency-block)] p-0.5",
        className
      )}
      data-slot="segment-bar"
      data-testid={testId}
      ref={containerRef}
      role="tablist"
    >
      {indicator.ready ? (
        <span
          aria-hidden="true"
          className="absolute top-0.5 bottom-0.5 rounded-[5px] bg-[var(--background-board-card)] transition-[left,width] duration-150 ease-out"
          data-slot="segment-bar-indicator"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}
      {segments.map((segment) => {
        const isActive = value === segment.value;
        return (
          <button
            aria-selected={isActive}
            className={cn(
              "relative z-[1] inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-[5px] px-2.5 text-[12px] font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25",
              isActive
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            )}
            data-active={isActive ? "true" : "false"}
            data-slot="segment-bar-segment"
            data-testid={segment.testId}
            key={segment.value}
            ref={(node) => {
              if (node) {
                buttonRefs.current[segment.value] = node;
              }
            }}
            role="tab"
            type="button"
            onClick={() => onValueChange(segment.value)}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}

export { SegmentBar };
