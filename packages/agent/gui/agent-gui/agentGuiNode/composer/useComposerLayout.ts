import {
  useLayoutEffect,
  useMemo,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import type {
  AgentComposerDraftFile,
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
const DOCK_COMPOSER_INPUT_BORDER_HEIGHT = 2;
const DOCK_COMPOSER_INPUT_PADDING_BLOCK_HEIGHT = 24;
const PROMPT_TIP_CYCLE_STEP_MS = 5_200;
const COMPOSER_PALETTE_Z_INDEX = "var(--z-popover)";

function hasInlineOverflow(element: HTMLElement | null): boolean {
  return Boolean(element && element.scrollWidth > element.clientWidth);
}

interface UseComposerLayoutInput {
  isHeroLayout: boolean;
  inputDisabled: boolean;
  paletteDraftPrompt: string;
  showFileMentionPalette: boolean;
  showFloatingCommandMenu: boolean;
  previewMode: boolean;
  promptTips: readonly { id: string; label: string; prompt: string }[];
  promptTipsPrefix: string;
  composerSettings: AgentGUIComposerSettingsVM;
  selectedProjectPath: string;
  promptTipRef: RefObject<HTMLSpanElement | null>;
  promptInputAreaRef: RefObject<HTMLDivElement | null>;
  isPromptTipOverflowing: boolean;
  setIsPromptTipOverflowing: Dispatch<SetStateAction<boolean>>;
  dockComposerInputHeight: number;
  setDockComposerInputHeight: Dispatch<SetStateAction<number>>;
  dockComposerInputMaxHeight: number;
  setDockComposerInputMaxHeight: Dispatch<SetStateAction<number>>;
  dockComposerAttachmentHeight: number;
  setDockComposerAttachmentHeight: Dispatch<SetStateAction<number>>;
  dockComposerTextHeight: number;
  setDockComposerTextHeight: Dispatch<SetStateAction<number>>;
  draftImages: AgentComposerDraftImage[];
  draftFiles: AgentComposerDraftFile[];
  draftLargeTexts: AgentComposerDraftLargeText[];
}

export function useComposerLayout({
  isHeroLayout,
  inputDisabled,
  paletteDraftPrompt,
  showFileMentionPalette,
  showFloatingCommandMenu,
  previewMode,
  promptTips,
  promptTipsPrefix,
  composerSettings,
  selectedProjectPath,
  promptTipRef,
  promptInputAreaRef,
  isPromptTipOverflowing,
  setIsPromptTipOverflowing,
  dockComposerInputHeight,
  setDockComposerInputHeight,
  dockComposerInputMaxHeight,
  setDockComposerInputMaxHeight,
  dockComposerAttachmentHeight,
  setDockComposerAttachmentHeight,
  dockComposerTextHeight,
  setDockComposerTextHeight,
  draftImages,
  draftFiles,
  draftLargeTexts
}: UseComposerLayoutInput) {
  const labels = { promptTipsPrefix };
  const showEdgeGlow = isHeroLayout && !inputDisabled;
  const showPromptTips = isHeroLayout && promptTips.length > 0;
  const activePromptTip = showPromptTips ? (promptTips[0] ?? null) : null;
  const showHeroProjectSelector = isHeroLayout;
  const showProjectRow = isHeroLayout;
  const showProjectMissingProbe =
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
    if (previewMode) {
      setIsPromptTipOverflowing(false);
      return;
    }
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

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    activePromptTipId,
    activePromptTipText,
    isPromptTipOverflowing,
    previewMode
  ]);
  useLayoutEffect(() => {
    if (isHeroLayout) {
      setDockComposerInputHeight(DOCK_COMPOSER_INPUT_MIN_HEIGHT);
      setDockComposerInputMaxHeight(DOCK_COMPOSER_INPUT_MAX_HEIGHT);
      setDockComposerAttachmentHeight(0);
      setDockComposerTextHeight(DOCK_COMPOSER_INPUT_MIN_HEIGHT);
      return;
    }

    const inputArea = promptInputAreaRef.current;
    const editor = inputArea?.querySelector(
      ".agent-gui-node__composer-textarea"
    );
    if (!inputArea || !(editor instanceof HTMLElement)) {
      setDockComposerInputHeight(DOCK_COMPOSER_INPUT_MIN_HEIGHT);
      return;
    }

    const measure = (): void => {
      // Both attachment rows contribute to the composer height: images live in
      // one container and files/pasted-text chips in another. Measuring only the
      // image row clipped the taller pasted-text chip ("展示不全").
      const attachmentAreas = inputArea.querySelectorAll(
        '[data-testid="agent-gui-composer-image-drafts"], [data-testid="agent-gui-composer-file-drafts"]'
      );
      let attachmentHeight = 0;
      attachmentAreas.forEach((area) => {
        if (area instanceof HTMLElement) {
          attachmentHeight += area.scrollHeight;
        }
      });
      const textHeight = Math.min(
        DOCK_COMPOSER_INPUT_MAX_HEIGHT,
        Math.max(
          DOCK_COMPOSER_INPUT_MIN_HEIGHT,
          editor.scrollHeight +
            DOCK_COMPOSER_INPUT_TEXT_MEASUREMENT_CHROME_HEIGHT
        )
      );
      const attachmentChromeHeight =
        attachmentHeight > 0 ? DOCK_COMPOSER_INPUT_PADDING_BLOCK_HEIGHT : 0;
      const maxHeight =
        DOCK_COMPOSER_INPUT_MAX_HEIGHT +
        Math.max(0, attachmentHeight) +
        attachmentChromeHeight;
      const previousHeight = inputArea.style.height;
      const previousInputHeight = inputArea.style.getPropertyValue(
        "--agent-gui-composer-input-height"
      );
      const previousInputMaxHeight = inputArea.style.getPropertyValue(
        "--agent-gui-composer-input-max-height"
      );
      const previousAttachmentHeight = inputArea.style.getPropertyValue(
        "--agent-gui-composer-attachment-height"
      );
      inputArea.style.height = "auto";
      inputArea.style.setProperty(
        "--agent-gui-composer-input-height",
        `${DOCK_COMPOSER_INPUT_MIN_HEIGHT}px`
      );
      inputArea.style.setProperty(
        "--agent-gui-composer-input-max-height",
        `${maxHeight}px`
      );
      inputArea.style.setProperty(
        "--agent-gui-composer-attachment-height",
        `${attachmentHeight}px`
      );
      const contentHeight = inputArea.scrollHeight;
      inputArea.style.height = previousHeight;
      if (previousInputHeight) {
        inputArea.style.setProperty(
          "--agent-gui-composer-input-height",
          previousInputHeight
        );
      } else {
        inputArea.style.removeProperty("--agent-gui-composer-input-height");
      }
      if (previousInputMaxHeight) {
        inputArea.style.setProperty(
          "--agent-gui-composer-input-max-height",
          previousInputMaxHeight
        );
      } else {
        inputArea.style.removeProperty("--agent-gui-composer-input-max-height");
      }
      if (previousAttachmentHeight) {
        inputArea.style.setProperty(
          "--agent-gui-composer-attachment-height",
          previousAttachmentHeight
        );
      } else {
        inputArea.style.removeProperty(
          "--agent-gui-composer-attachment-height"
        );
      }
      const measuredHeight = Math.max(
        contentHeight + DOCK_COMPOSER_INPUT_BORDER_HEIGHT,
        attachmentHeight + textHeight + attachmentChromeHeight
      );
      const nextHeight = Math.min(
        maxHeight,
        Math.max(DOCK_COMPOSER_INPUT_MIN_HEIGHT, measuredHeight)
      );
      setDockComposerInputHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight
      );
      setDockComposerInputMaxHeight((currentHeight) =>
        currentHeight === maxHeight ? currentHeight : maxHeight
      );
      setDockComposerAttachmentHeight((currentHeight) =>
        currentHeight === attachmentHeight ? currentHeight : attachmentHeight
      );
      setDockComposerTextHeight((currentHeight) =>
        currentHeight === textHeight ? currentHeight : textHeight
      );
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(inputArea);
    resizeObserver?.observe(editor);
    for (const child of Array.from(inputArea.querySelectorAll("*"))) {
      resizeObserver?.observe(child);
    }
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    draftFiles.length,
    draftImages.length,
    draftLargeTexts.length,
    isHeroLayout,
    paletteDraftPrompt
  ]);
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
            "--agent-gui-composer-attachment-height": `${dockComposerAttachmentHeight}px`,
            "--agent-gui-composer-input-height": `${dockComposerInputHeight}px`,
            "--agent-gui-composer-input-max-height": `${dockComposerInputMaxHeight}px`,
            "--agent-gui-composer-text-height": `${dockComposerTextHeight}px`,
            "--agent-gui-composer-text-line-height": `${DOCK_COMPOSER_TEXT_LINE_HEIGHT}px`,
            "--agent-gui-composer-text-max-visible-lines": `${DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES}`,
            "--agent-gui-composer-text-viewport-height": `${DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT}px`
          } as CSSProperties),
    [
      dockComposerAttachmentHeight,
      dockComposerInputHeight,
      dockComposerInputMaxHeight,
      dockComposerTextHeight,
      isHeroLayout
    ]
  );

  return {
    activePromptTip,
    activePromptTipText,
    inputShellStyle,
    promptInputAreaStyle,
    promptTipStyle,
    rotatingPromptTips,
    showEdgeGlow,
    showHeroProjectSelector,
    showProjectMissingProbe,
    showProjectRow
  };
}
