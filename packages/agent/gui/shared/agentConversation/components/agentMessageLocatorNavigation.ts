import type { AgentMessageLocatorItem } from "./agentTranscriptModel";
import {
  requestUiAnimationFrame,
  scheduleUiTimeout
} from "./agentTranscriptPresentationScheduler";
import { setAgentTranscriptScrollTop } from "./agentTranscriptScrollController";

const AGENT_MESSAGE_LOCATOR_KEYBOARD_TOP_THRESHOLD_PX = 24;
const AGENT_MESSAGE_LOCATOR_KEYBOARD_CORRECTION_MS = 350;
const AGENT_MESSAGE_LOCATOR_MOUNT_WAIT_MS = 1_500;

export interface AgentMessageLocatorVisibleFrame {
  heightPx: number;
  topOffsetPx: number;
}

export interface AgentMessageLocatorLocateOptions {
  align: "center" | "top";
  behavior: "auto" | "smooth";
  signal?: AbortSignal;
}

export interface AgentMessageLocatorTarget {
  measureElement: HTMLElement;
  scrollElement: HTMLElement;
}

export function findKeyboardLocatorTarget(
  items: readonly AgentMessageLocatorItem[],
  scrollParent: HTMLElement,
  direction: "next" | "previous"
): AgentMessageLocatorItem | null {
  const rowByKey = new Map<string, HTMLElement>();
  for (const row of scrollParent.querySelectorAll<HTMLElement>(
    "[data-agent-message-locator-key]"
  )) {
    const key = row.dataset.agentMessageLocatorKey;
    if (key && !rowByKey.has(key)) {
      rowByKey.set(key, row);
    }
  }
  const mounted = items.flatMap((item, index) => {
    const row = rowByKey.get(item.key);
    const target = row ? resolveTranscriptLocatorTarget(row) : null;
    return target ? [{ element: target.measureElement, index, item }] : [];
  });
  if (mounted.length === 0) {
    return direction === "next" ? (items[0] ?? null) : (items.at(-1) ?? null);
  }

  const rootTop = scrollParent.getBoundingClientRect().top;
  if (direction === "next") {
    const mountedTargetIndex = mounted.findIndex(
      ({ element }) =>
        element.getBoundingClientRect().top >
        rootTop + AGENT_MESSAGE_LOCATOR_KEYBOARD_TOP_THRESHOLD_PX
    );
    if (mountedTargetIndex >= 0) {
      const previousMountedIndex = mounted[mountedTargetIndex - 1]?.index ?? -1;
      return items[previousMountedIndex + 1] ?? null;
    }
    const lastMountedIndex = mounted.at(-1)?.index ?? -1;
    return items[lastMountedIndex + 1] ?? null;
  }

  for (let index = mounted.length - 1; index >= 0; index -= 1) {
    const target = mounted[index];
    if (!target) continue;
    const targetTop = target.element.getBoundingClientRect().top;
    if (
      Math.abs(targetTop - rootTop) <=
      AGENT_MESSAGE_LOCATOR_KEYBOARD_TOP_THRESHOLD_PX
    )
      return items[target.index - 1] ?? null;
    if (targetTop < rootTop) return target.item;
  }
  return mounted[0]?.item ?? null;
}

export function findKeyboardEventTimeline(
  event: KeyboardEvent
): HTMLElement | null {
  for (const target of event.composedPath()) {
    if (
      target instanceof HTMLElement &&
      target.matches('[data-testid="agent-gui-timeline"]')
    ) {
      return target;
    }
  }
  return (
    (event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-testid="agent-gui-timeline"]')
      : null) ??
    document.querySelector<HTMLElement>('[data-testid="agent-gui-timeline"]')
  );
}

export function scrollTranscriptRowIntoView(
  row: HTMLElement,
  scrollParent: HTMLElement | null,
  options: AgentMessageLocatorLocateOptions = {
    align: "center",
    behavior: "smooth"
  }
): boolean {
  if (!scrollParent || options.signal?.aborted) {
    return false;
  }
  const target = findExactTranscriptLocatorTarget(row);
  if (options.align === "top") {
    setAgentTranscriptScrollTop(
      scrollParent,
      targetScrollTopForTranscriptRowTop(target, scrollParent),
      options.behavior
    );
    return true;
  }

  const targetScrollTop = targetScrollTopForTranscriptRow(target, scrollParent);
  setAgentTranscriptScrollTop(scrollParent, targetScrollTop, options.behavior);
  return true;
}

export function findTranscriptLocatorTarget(
  scrollParent: HTMLElement,
  itemKey: string
): AgentMessageLocatorTarget | null {
  for (const row of scrollParent.querySelectorAll<HTMLElement>(
    "[data-agent-message-locator-key]"
  )) {
    if (row.dataset.agentMessageLocatorKey === itemKey) {
      return resolveTranscriptLocatorTarget(row);
    }
  }
  return null;
}

export function scrollMountedTranscriptLocatorTarget(
  target: AgentMessageLocatorTarget,
  behavior: AgentMessageLocatorLocateOptions["behavior"]
): void {
  target.scrollElement.scrollIntoView({
    behavior: (behavior === "auto" ? "instant" : behavior) as ScrollBehavior,
    block: "start"
  });
}

export function scrollKeyboardTranscriptLocatorTarget(
  scrollParent: HTMLElement,
  target: AgentMessageLocatorTarget,
  signal?: AbortSignal
): void {
  scrollMountedTranscriptLocatorTarget(target, "smooth");
  scheduleUiTimeout(() => {
    if (
      signal?.aborted ||
      !scrollParent.isConnected ||
      !target.measureElement.isConnected ||
      !target.scrollElement.isConnected
    ) {
      return;
    }
    const rootTop = scrollParent.getBoundingClientRect().top;
    const targetTop = target.measureElement.getBoundingClientRect().top;
    if (
      Math.abs(targetTop - rootTop) >
      AGENT_MESSAGE_LOCATOR_KEYBOARD_TOP_THRESHOLD_PX
    ) {
      scrollMountedTranscriptLocatorTarget(target, "smooth");
    }
  }, AGENT_MESSAGE_LOCATOR_KEYBOARD_CORRECTION_MS);
}

export function waitForTranscriptLocatorTarget(
  scrollParent: HTMLElement,
  itemKey: string,
  signal?: AbortSignal
): Promise<AgentMessageLocatorTarget | null> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const inspect = (): void => {
      const target =
        !signal?.aborted && scrollParent.isConnected
          ? findTranscriptLocatorTarget(scrollParent, itemKey)
          : null;
      if (
        target ||
        signal?.aborted ||
        !scrollParent.isConnected ||
        performance.now() - startedAt > AGENT_MESSAGE_LOCATOR_MOUNT_WAIT_MS
      ) {
        resolve(target);
        return;
      }
      requestUiAnimationFrame(inspect);
    };
    inspect();
  });
}

export function readMessageLocatorVisibleFrame(
  scrollParent: HTMLElement
): AgentMessageLocatorVisibleFrame {
  const style = window.getComputedStyle(scrollParent);
  const topOffsetPx = parseCssPx(style.scrollPaddingTop);
  const bottomOffsetPx = parseCssPx(style.scrollPaddingBottom);
  return {
    heightPx: Math.max(
      0,
      scrollParent.clientHeight - topOffsetPx - bottomOffsetPx
    ),
    topOffsetPx
  };
}

export function highlightTranscriptLocatorTarget(row: HTMLElement): void {
  const target = findExactTranscriptLocatorTarget(row);
  if (typeof target.animate !== "function") {
    return;
  }
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (target.matches("[data-agent-transcript-attachment]")) {
    target.animate(
      [
        { boxShadow: "0 0 0 2px var(--tutti-purple)" },
        { boxShadow: "0 0 0 2px transparent" }
      ],
      { duration: reduceMotion ? 0 : 1_400, easing: "ease-out" }
    );
    return;
  }
  target.animate(
    [
      {
        backgroundColor:
          "color-mix(in srgb, var(--text-primary) 14%, transparent)"
      },
      {
        backgroundColor:
          "color-mix(in srgb, var(--text-primary) 14%, transparent)",
        offset: 0.35
      },
      {
        backgroundColor:
          "color-mix(in srgb, var(--text-primary) 5%, transparent)"
      }
    ],
    {
      duration: reduceMotion ? 0 : 1_400,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)"
    }
  );
}

export function findExactTranscriptLocatorTarget(
  row: HTMLElement
): HTMLElement {
  return resolveTranscriptLocatorTarget(row).measureElement;
}

function resolveTranscriptLocatorTarget(
  row: HTMLElement
): AgentMessageLocatorTarget {
  const bubble = row.querySelector<HTMLElement>(
    ".agent-gui-conversation__user-message-bubble"
  );
  if (bubble) {
    return { measureElement: bubble, scrollElement: row };
  }
  const attachment = row.querySelector<HTMLElement>(
    "[data-agent-transcript-attachment]"
  );
  const element = attachment ?? row;
  return { measureElement: element, scrollElement: element };
}

function targetScrollTopForTranscriptRow(
  row: HTMLElement,
  scrollParent: HTMLElement
): number {
  const rowRect = row.getBoundingClientRect();
  const scrollParentRect = scrollParent.getBoundingClientRect();
  const visibleFrame = readMessageLocatorVisibleFrame(scrollParent);
  const targetDelta =
    rowRect.top +
    rowRect.height / 2 -
    (scrollParentRect.top +
      visibleFrame.topOffsetPx +
      visibleFrame.heightPx / 2);
  return Math.min(0, scrollParent.scrollTop + targetDelta);
}

function targetScrollTopForTranscriptRowTop(
  row: HTMLElement,
  scrollParent: HTMLElement
): number {
  const rowRect = row.getBoundingClientRect();
  const scrollParentRect = scrollParent.getBoundingClientRect();
  const visibleFrame = readMessageLocatorVisibleFrame(scrollParent);
  const targetScrollTop =
    scrollParent.scrollTop +
    rowRect.top -
    scrollParentRect.top -
    visibleFrame.topOffsetPx;
  return Math.min(0, targetScrollTop);
}

function parseCssPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
