const postCompositionSuppressMs = 80;

export interface TerminalImeKeyEvent {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  type: string;
}

export interface TerminalImeInputGuard {
  dispose(): void;
  handleCompositionEnd(): void;
  handleCompositionStart(): void;
  shouldProcessKeyEvent(event: TerminalImeKeyEvent): boolean;
}

export function createTerminalImeInputGuard(input: {
  now?: () => number;
  textarea?: HTMLTextAreaElement;
}): TerminalImeInputGuard {
  const now = input.now ?? (() => Date.now());
  let composing = false;
  let compositionEndedAt: number | null = null;

  const guard: TerminalImeInputGuard = {
    dispose() {
      input.textarea?.removeEventListener(
        "compositionstart",
        guard.handleCompositionStart
      );
      input.textarea?.removeEventListener(
        "compositionend",
        guard.handleCompositionEnd
      );
    },
    handleCompositionEnd() {
      composing = false;
      compositionEndedAt = now();
    },
    handleCompositionStart() {
      composing = true;
      compositionEndedAt = null;
    },
    shouldProcessKeyEvent(event) {
      if (!isKeyInputEvent(event)) {
        return true;
      }
      if (isModifierOnlyKey(event.key)) {
        return true;
      }
      if (composing || event.isComposing) {
        return false;
      }
      if (compositionEndedAt === null) {
        return true;
      }
      if (now() - compositionEndedAt > postCompositionSuppressMs) {
        compositionEndedAt = null;
        return true;
      }
      if (!isPlainKeyEvent(event)) {
        compositionEndedAt = null;
        return true;
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      return false;
    }
  };

  input.textarea?.addEventListener(
    "compositionstart",
    guard.handleCompositionStart
  );
  input.textarea?.addEventListener(
    "compositionend",
    guard.handleCompositionEnd
  );

  return guard;
}

function isKeyInputEvent(event: TerminalImeKeyEvent): boolean {
  return event.type === "keydown" || event.type === "keypress";
}

function isPlainKeyEvent(event: TerminalImeKeyEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey;
}

function isModifierOnlyKey(key: string): boolean {
  return (
    key === "Alt" ||
    key === "AltGraph" ||
    key === "Control" ||
    key === "Meta" ||
    key === "Shift"
  );
}
