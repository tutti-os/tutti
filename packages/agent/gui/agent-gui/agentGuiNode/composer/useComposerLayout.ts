import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import type {
  AgentComposerDraftImage,
  AgentComposerDraftLargeText,
  AgentGUIComposerSettingsVM
} from "../model/agentGuiNodeTypes";

const DOCK_COMPOSER_INPUT_MIN_HEIGHT = 56;
const DOCK_COMPOSER_TEXT_LINE_HEIGHT = 24;
const DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES = 3.5;
// The editor owns the 12px top inset so transformed rich-text nodes cannot be
// clipped by its scroll viewport. Only the bottom inset and borders remain
// outside editor.scrollHeight.
const DOCK_COMPOSER_INPUT_TEXT_MEASUREMENT_CHROME_HEIGHT = 14;
const DOCK_COMPOSER_INPUT_TEXT_MAX_HEIGHT_CHROME = 26;
const DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT =
  DOCK_COMPOSER_TEXT_LINE_HEIGHT * DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES;
const DOCK_COMPOSER_INPUT_MAX_HEIGHT =
  DOCK_COMPOSER_INPUT_TEXT_MAX_HEIGHT_CHROME +
  DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT;
const DOCK_COMPOSER_INPUT_PADDING_BLOCK_HEIGHT = 24;
const PROMPT_TIP_CYCLE_STEP_MS = 5_200;
const COMPOSER_PALETTE_Z_INDEX = "var(--z-popover)";
const COMPOSER_ATTACHMENT_SELECTOR =
  '[data-testid="agent-gui-composer-image-drafts"], [data-testid="agent-gui-composer-file-drafts"]';

export interface DockComposerMetrics {
  attachmentHeight: number;
  inputHeight: number;
  inputMaxHeight: number;
  textHeight: number;
}

export const INITIAL_DOCK_COMPOSER_METRICS: DockComposerMetrics = {
  attachmentHeight: 0,
  inputHeight: DOCK_COMPOSER_INPUT_MIN_HEIGHT,
  inputMaxHeight: DOCK_COMPOSER_INPUT_MAX_HEIGHT,
  textHeight: DOCK_COMPOSER_INPUT_MIN_HEIGHT
};

function hasInlineOverflow(element: HTMLElement | null): boolean {
  return Boolean(element && element.scrollWidth > element.clientWidth);
}

interface UseComposerLayoutInput {
  isHeroLayout: boolean;
  inputDisabled: boolean;
  projectMissingProbeEnabled: boolean;
  showFileMentionPalette: boolean;
  showFloatingCommandMenu: boolean;
  promptTips: readonly { id: string; label: string; prompt: string }[];
  promptTipsPrefix: string;
  composerSettings: AgentGUIComposerSettingsVM;
  selectedProjectPath: string;
  promptTipRef: RefObject<HTMLSpanElement | null>;
  promptInputAreaRef: RefObject<HTMLDivElement | null>;
  setIsPromptTipOverflowing: Dispatch<SetStateAction<boolean>>;
  dockComposerMetrics: DockComposerMetrics;
  setDockComposerMetrics: Dispatch<SetStateAction<DockComposerMetrics>>;
  draftImages: AgentComposerDraftImage[];
  draftLargeTexts: AgentComposerDraftLargeText[];
}

export function useComposerLayout({
  isHeroLayout,
  inputDisabled,
  projectMissingProbeEnabled,
  showFileMentionPalette,
  showFloatingCommandMenu,
  promptTips,
  promptTipsPrefix,
  composerSettings,
  selectedProjectPath,
  promptTipRef,
  promptInputAreaRef,
  setIsPromptTipOverflowing,
  dockComposerMetrics,
  setDockComposerMetrics,
  draftImages,
  draftLargeTexts
}: UseComposerLayoutInput) {
  const composerMeasurementFrameRef = useRef<number | null>(null);
  const labels = { promptTipsPrefix };
  const showEdgeGlow = isHeroLayout && !inputDisabled;
  const showPromptTips = isHeroLayout && promptTips.length > 0;
  const activePromptTip = showPromptTips ? (promptTips[0] ?? null) : null;
  const showHeroProjectSelector = isHeroLayout;
  const showProjectRow = isHeroLayout;
  const showProjectMissingProbe =
    projectMissingProbeEnabled &&
    !showProjectRow &&
    Boolean(composerSettings.projectLocked) &&
    selectedProjectPath !== "" &&
    // Remote runtimes (shared/cloud sandbox) run their cwd off the local
    // filesystem, so the local existence check would always false-positive.
    !composerSettings.projectPathIsRemote;
  const activePromptTipId = activePromptTip?.id ?? null;
  const activePromptTipText = activePromptTip
    ? `${labels.promptTipsPrefix}${activePromptTip.label} · ${activePromptTip.prompt}`
    : "";
  const rotatingPromptTips =
    activePromptTip && promptTips.length > 1
      ? [...promptTips, activePromptTip]
      : activePromptTip
        ? [activePromptTip]
        : [];
  const promptTipStyle =
    promptTips.length > 1
      ? ({
          "--agent-gui-prompt-tip-count": promptTips.length,
          "--agent-gui-prompt-tip-cycle-duration": `${
            promptTips.length * PROMPT_TIP_CYCLE_STEP_MS
          }ms`
        } as CSSProperties)
      : undefined;
  useLayoutEffect(() => {
    if (!activePromptTipId) {
      setIsPromptTipOverflowing(false);
      return;
    }

    const element = promptTipRef.current;
    if (!element) {
      setIsPromptTipOverflowing(false);
      return;
    }

    const measure = (): void => {
      setIsPromptTipOverflowing(hasInlineOverflow(element));
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }
    return () => {
      resizeObserver?.disconnect();
    };
  }, [activePromptTipId, activePromptTipText]);
  const measureDockComposer = useCallback((): void => {
    composerMeasurementFrameRef.current = null;
    if (isHeroLayout) {
      setDockComposerMetrics((currentMetrics) =>
        areDockComposerMetricsEqual(
          currentMetrics,
          INITIAL_DOCK_COMPOSER_METRICS
        )
          ? currentMetrics
          : INITIAL_DOCK_COMPOSER_METRICS
      );
      return;
    }
    const inputArea = promptInputAreaRef.current;
    const editor = inputArea?.querySelector(
      ".agent-gui-node__composer-textarea"
    );
    if (!inputArea || !(editor instanceof HTMLElement)) {
      setDockComposerMetrics((currentMetrics) =>
        currentMetrics.inputHeight === DOCK_COMPOSER_INPUT_MIN_HEIGHT
          ? currentMetrics
          : {
              ...currentMetrics,
              inputHeight: DOCK_COMPOSER_INPUT_MIN_HEIGHT
            }
      );
      return;
    }

    // Both attachment rows contribute to the composer height: images live in
    // one container and files/pasted-text chips in another. Measuring only the
    // image row clipped the taller pasted-text chip ("展示不全").
    const attachmentAreas = inputArea.querySelectorAll(
      COMPOSER_ATTACHMENT_SELECTOR
    );
    let attachmentHeight = 0;
    attachmentAreas.forEach((area) => {
      if (area instanceof HTMLElement) {
        attachmentHeight += area.scrollHeight;
      }
    });
    const editorContentHeight = readEditorIntrinsicContentHeight(editor);
    const textHeight = Math.min(
      DOCK_COMPOSER_INPUT_MAX_HEIGHT,
      Math.max(
        DOCK_COMPOSER_INPUT_MIN_HEIGHT,
        editorContentHeight + DOCK_COMPOSER_INPUT_TEXT_MEASUREMENT_CHROME_HEIGHT
      )
    );
    const attachmentChromeHeight =
      attachmentHeight > 0 ? DOCK_COMPOSER_INPUT_PADDING_BLOCK_HEIGHT : 0;
    const inputMaxHeight =
      DOCK_COMPOSER_INPUT_MAX_HEIGHT +
      Math.max(0, attachmentHeight) +
      attachmentChromeHeight;
    const measuredHeight =
      attachmentHeight + textHeight + attachmentChromeHeight;
    const inputHeight = Math.min(
      inputMaxHeight,
      Math.max(DOCK_COMPOSER_INPUT_MIN_HEIGHT, measuredHeight)
    );
    const nextMetrics: DockComposerMetrics = {
      attachmentHeight,
      inputHeight,
      inputMaxHeight,
      textHeight
    };
    setDockComposerMetrics((currentMetrics) =>
      areDockComposerMetricsEqual(currentMetrics, nextMetrics)
        ? currentMetrics
        : nextMetrics
    );
  }, [isHeroLayout, promptInputAreaRef, setDockComposerMetrics]);

  const invalidateComposerMeasurement = useCallback((): void => {
    if (composerMeasurementFrameRef.current !== null) {
      return;
    }
    if (typeof window.requestAnimationFrame !== "function") {
      measureDockComposer();
      return;
    }
    composerMeasurementFrameRef.current =
      window.requestAnimationFrame(measureDockComposer);
  }, [measureDockComposer]);

  useLayoutEffect(() => {
    if (isHeroLayout) {
      invalidateComposerMeasurement();
      return () => {
        if (composerMeasurementFrameRef.current !== null) {
          window.cancelAnimationFrame(composerMeasurementFrameRef.current);
          composerMeasurementFrameRef.current = null;
        }
      };
    }
    const inputArea = promptInputAreaRef.current;
    const widthHost = inputArea?.parentElement ?? null;
    let observedWidth: number | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            let shouldInvalidate = false;
            for (const entry of entries) {
              if (entry.target === widthHost) {
                const nextWidth = entry.contentRect.width;
                if (nextWidth !== observedWidth) {
                  observedWidth = nextWidth;
                  shouldInvalidate = true;
                }
              } else {
                shouldInvalidate = true;
              }
            }
            if (shouldInvalidate) {
              invalidateComposerMeasurement();
            }
          });
    if (widthHost) {
      resizeObserver?.observe(widthHost);
    }
    for (const attachmentArea of Array.from(
      inputArea?.querySelectorAll(COMPOSER_ATTACHMENT_SELECTOR) ?? []
    )) {
      resizeObserver?.observe(attachmentArea);
    }
    invalidateComposerMeasurement();
    return () => {
      if (composerMeasurementFrameRef.current !== null) {
        window.cancelAnimationFrame(composerMeasurementFrameRef.current);
        composerMeasurementFrameRef.current = null;
      }
      resizeObserver?.disconnect();
    };
  }, [
    draftImages.length,
    draftLargeTexts.length,
    invalidateComposerMeasurement,
    isHeroLayout,
    promptInputAreaRef
  ]);
  const composerStyle = useMemo<CSSProperties | undefined>(
    () =>
      isHeroLayout
        ? undefined
        : ({
            // The dock keeps only the collapsed 56px input row in flow; a
            // growing draft overhangs upward past the composer's top edge.
            // Floating panels anchored to that edge (queued prompts, the
            // interactive prompt) read this var to stay above the grown input
            // instead of being covered by it.
            "--agent-gui-composer-input-overflow": `${Math.max(
              0,
              dockComposerMetrics.inputHeight - DOCK_COMPOSER_INPUT_MIN_HEIGHT
            )}px`
          } as CSSProperties),
    [dockComposerMetrics.inputHeight, isHeroLayout]
  );
  const inputShellStyle = useMemo<CSSProperties | undefined>(
    () =>
      showFileMentionPalette || showFloatingCommandMenu
        ? { zIndex: COMPOSER_PALETTE_Z_INDEX }
        : undefined,
    [showFileMentionPalette, showFloatingCommandMenu]
  );
  const promptInputAreaStyle = useMemo<CSSProperties | undefined>(
    () =>
      isHeroLayout
        ? undefined
        : ({
            "--agent-gui-composer-attachment-height": `${dockComposerMetrics.attachmentHeight}px`,
            "--agent-gui-composer-input-height": `${dockComposerMetrics.inputHeight}px`,
            "--agent-gui-composer-input-max-height": `${dockComposerMetrics.inputMaxHeight}px`,
            "--agent-gui-composer-text-height": `${dockComposerMetrics.textHeight}px`,
            "--agent-gui-composer-text-line-height": `${DOCK_COMPOSER_TEXT_LINE_HEIGHT}px`,
            "--agent-gui-composer-text-max-visible-lines": `${DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES}`,
            "--agent-gui-composer-text-viewport-height": `${DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT}px`
          } as CSSProperties),
    [dockComposerMetrics, isHeroLayout]
  );

  return {
    activePromptTip,
    activePromptTipText,
    composerStyle,
    inputShellStyle,
    promptInputAreaStyle,
    promptTipStyle,
    rotatingPromptTips,
    invalidateComposerMeasurement,
    showEdgeGlow,
    showHeroProjectSelector,
    showProjectMissingProbe,
    showProjectRow
  };
}

function readEditorIntrinsicContentHeight(editor: HTMLElement): number {
  const firstBlock = editor.firstElementChild;
  const lastBlock = editor.lastElementChild;
  if (firstBlock instanceof HTMLElement && lastBlock instanceof HTMLElement) {
    const firstRect = firstBlock.getBoundingClientRect();
    const lastRect = lastBlock.getBoundingClientRect();
    const contentHeight = lastRect.bottom - firstRect.top;
    if (contentHeight > 0) {
      const style = window.getComputedStyle(editor);
      return (
        contentHeight +
        parseCssPixelValue(style.paddingTop) +
        parseCssPixelValue(style.paddingBottom)
      );
    }
  }
  return editor.scrollHeight;
}

function parseCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function areDockComposerMetricsEqual(
  left: DockComposerMetrics,
  right: DockComposerMetrics
): boolean {
  return (
    left.attachmentHeight === right.attachmentHeight &&
    left.inputHeight === right.inputHeight &&
    left.inputMaxHeight === right.inputMaxHeight &&
    left.textHeight === right.textHeight
  );
}
