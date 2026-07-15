import * as React from "react";

import { cn } from "#lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "../tooltip/tooltip";

/**
 * 监测元素或指定后代是否因 overflow 被截断(scrollWidth > clientWidth)。
 * 返回要挂到「截断元素」上的 ref,以及是否正在溢出。随容器尺寸变化实时更新。
 */
export function useTextOverflow<T extends HTMLElement = HTMLElement>(
  watch: unknown,
  descendantSelector?: string
): { ref: React.RefObject<T | null>; overflowing: boolean } {
  const ref = React.useRef<T>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const overflowCandidates = (): HTMLElement[] => [
      element,
      ...(descendantSelector
        ? element.querySelectorAll<HTMLElement>(descendantSelector)
        : [])
    ];
    const measure = (): void => {
      setOverflowing(
        overflowCandidates().some(
          (candidate) => candidate.scrollWidth - candidate.clientWidth > 1
        )
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    for (const candidate of overflowCandidates()) observer.observe(candidate);
    return () => observer.disconnect();
  }, [descendantSelector, watch]);

  return { ref, overflowing };
}

export interface TruncatingPillLabelProps {
  /** 完整文本;仅在标签被省略号截断时,通过 Tooltip 展示。 */
  tooltip: string;
  className?: string;
  children: React.ReactNode;
  withTooltipProvider?: boolean;
}

/**
 * mention chip 的标签:省略号截断 + 「超出才显示」的设计系统 Tooltip。
 * 仅当实际溢出(scrollWidth > clientWidth)时,hover 才弹出完整文本,避免短标签也弹无意义 tooltip。
 * 依赖上层已挂载的 TooltipProvider(app 根已提供)。Trigger 始终包裹标签以保持 DOM 稳定,
 * 仅切换 TooltipContent 的渲染,从而 ResizeObserver 不会因重挂载而丢失。
 */
export function TruncatingPillLabel({
  tooltip,
  className,
  children,
  withTooltipProvider = true
}: TruncatingPillLabelProps): React.JSX.Element {
  const { ref: labelRef, overflowing } =
    useTextOverflow<HTMLSpanElement>(tooltip);

  const label = (
    <span
      ref={labelRef}
      className={cn(
        "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
        className
      )}
    >
      {children}
    </span>
  );

  if (!tooltip) {
    return label;
  }

  const tooltipElement = (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      {overflowing ? (
        <TooltipContent className="max-w-[min(420px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]">
          {tooltip}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
  return withTooltipProvider ? (
    <TooltipProvider delayDuration={200}>{tooltipElement}</TooltipProvider>
  ) : (
    tooltipElement
  );
}
