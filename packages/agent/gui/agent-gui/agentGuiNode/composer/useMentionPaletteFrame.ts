import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type RefObject
} from "react";
import {
  MENTION_PALETTE_GAP_PX,
  MENTION_PALETTE_MAX_HEIGHT_PX,
  MENTION_PALETTE_MIN_HEIGHT_PX,
  MENTION_PALETTE_VIEWPORT_PADDING_PX,
  composerPaletteZIndex,
  resolveMentionPalettePortalTarget,
  resolveMentionPaletteZIndex,
  type MentionPaletteFrame
} from "./AgentComposerChrome";

export function useMentionPaletteFrame(
  inputShellRef: RefObject<HTMLDivElement | null>,
  showFileMentionPalette: boolean
) {
  const [mentionPaletteFrame, setMentionPaletteFrame] =
    useState<MentionPaletteFrame | null>(null);
  const syncMentionPaletteFrame = useCallback((): void => {
    const anchor = inputShellRef.current;
    if (!anchor || typeof window === "undefined") {
      setMentionPaletteFrame(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(
      0,
      Math.min(
        rect.width,
        viewportWidth - MENTION_PALETTE_VIEWPORT_PADDING_PX * 2
      )
    );
    const left = Math.max(
      MENTION_PALETTE_VIEWPORT_PADDING_PX,
      Math.min(
        rect.left,
        viewportWidth - MENTION_PALETTE_VIEWPORT_PADDING_PX - width
      )
    );
    const availableAbove =
      rect.top - MENTION_PALETTE_GAP_PX - MENTION_PALETTE_VIEWPORT_PADDING_PX;
    const height =
      availableAbove >= MENTION_PALETTE_MIN_HEIGHT_PX
        ? Math.min(MENTION_PALETTE_MAX_HEIGHT_PX, availableAbove)
        : MENTION_PALETTE_MIN_HEIGHT_PX;

    setMentionPaletteFrame({
      height,
      left,
      portalTarget: resolveMentionPalettePortalTarget(anchor),
      top: Math.max(
        MENTION_PALETTE_VIEWPORT_PADDING_PX,
        Math.min(
          rect.top - MENTION_PALETTE_GAP_PX - height,
          viewportHeight - MENTION_PALETTE_VIEWPORT_PADDING_PX - height
        )
      ),
      width,
      zIndex: resolveMentionPaletteZIndex(anchor)
    });
  }, []);

  useLayoutEffect(() => {
    if (!showFileMentionPalette) {
      setMentionPaletteFrame(null);
      return;
    }

    syncMentionPaletteFrame();
    const anchor = inputShellRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncMentionPaletteFrame);
    if (anchor) {
      resizeObserver?.observe(anchor);
    }
    window.addEventListener("resize", syncMentionPaletteFrame);
    window.addEventListener("scroll", syncMentionPaletteFrame, {
      capture: true,
      passive: true
    });
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncMentionPaletteFrame);
      window.removeEventListener("scroll", syncMentionPaletteFrame, true);
    };
  }, [showFileMentionPalette, syncMentionPaletteFrame]);

  const mentionPaletteStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      left: `${mentionPaletteFrame?.left ?? 0}px`,
      top: `${mentionPaletteFrame?.top ?? 0}px`,
      width: `${mentionPaletteFrame?.width ?? 0}px`,
      maxWidth: `${mentionPaletteFrame?.width ?? 0}px`,
      minHeight: `${MENTION_PALETTE_MIN_HEIGHT_PX}px`,
      maxHeight: `${MENTION_PALETTE_MAX_HEIGHT_PX}px`,
      height: `${mentionPaletteFrame?.height ?? MENTION_PALETTE_MIN_HEIGHT_PX}px`,
      zIndex: composerPaletteZIndex
    }),
    [mentionPaletteFrame]
  );
  const mentionPaletteHeightPx =
    mentionPaletteFrame?.height ?? MENTION_PALETTE_MIN_HEIGHT_PX;

  return { mentionPaletteFrame, mentionPaletteHeightPx, mentionPaletteStyle };
}
