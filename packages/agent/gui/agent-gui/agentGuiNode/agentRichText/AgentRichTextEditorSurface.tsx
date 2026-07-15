import {
  useCallback,
  useRef,
  type KeyboardEventHandler,
  type PointerEventHandler
} from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { cn } from "../../../app/renderer/lib/utils";
import type { TranslateFn } from "../../../i18n/index";
import type { AgentRichTextContextMenuState } from "./AgentRichTextEditor.types";

export function AgentRichTextEditorSurface({
  className,
  contextMenu,
  copySelection,
  cutSelection,
  disabled,
  editor,
  handleKeyDownCapture,
  handlePointerDownCapture,
  pasteClipboardText,
  placeholder,
  t
}: {
  className?: string;
  contextMenu: AgentRichTextContextMenuState | null;
  copySelection: () => void | Promise<void>;
  cutSelection: () => void | Promise<void>;
  disabled: boolean;
  editor: Editor | null;
  handleKeyDownCapture: KeyboardEventHandler<HTMLDivElement>;
  handlePointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  pasteClipboardText: () => void | Promise<void>;
  placeholder: string;
  t: TranslateFn;
}): React.JSX.Element {
  return (
    <div
      className="relative min-w-0"
      onKeyDownCapture={handleKeyDownCapture}
      onPointerDownCapture={handlePointerDownCapture}
    >
      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        <div
          role="textbox"
          aria-label={placeholder}
          aria-disabled={disabled ? "true" : "false"}
          aria-multiline="true"
          className={cn(
            className,
            "overflow-y-auto whitespace-pre-wrap break-words [&_p]:m-0"
          )}
        />
      )}
      {contextMenu
        ? createPortal(
            <div
              role="menu"
              aria-label={t("agentHost.agentGui.composerTextMenu")}
              className="fixed z-[var(--z-popover)] min-w-[132px] rounded-[8px] border border-[var(--line-1)] bg-[var(--background-panel)] p-1 text-[13px] text-[var(--text-primary)] shadow-[0_14px_34px_rgb(0_0_0_/_0.28)]"
              data-agent-composer-text-menu="true"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AgentRichTextContextMenuButton
                disabled={!contextMenu.canEdit || !contextMenu.hasSelection}
                label={t("common.cut")}
                onSelect={cutSelection}
              />
              <AgentRichTextContextMenuButton
                disabled={!contextMenu.hasSelection}
                label={t("common.copy")}
                onSelect={copySelection}
              />
              <AgentRichTextContextMenuButton
                disabled={!contextMenu.canEdit}
                label={t("common.paste")}
                onSelect={pasteClipboardText}
              />
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function AgentRichTextContextMenuButton({
  disabled,
  label,
  onSelect
}: {
  disabled: boolean;
  label: string;
  onSelect: () => void | Promise<void>;
}): React.JSX.Element {
  const selectionStartedRef = useRef(false);
  const select = useCallback(() => {
    if (disabled || selectionStartedRef.current) return;
    selectionStartedRef.current = true;
    void Promise.resolve(onSelect()).finally(() => {
      selectionStartedRef.current = false;
    });
  }, [disabled, onSelect]);

  return (
    <button
      role="menuitem"
      className="block w-full rounded-[6px] px-3 py-1.5 text-left font-medium transition-colors hover:bg-[var(--transparency-hover)] focus-visible:bg-[var(--transparency-hover)] focus-visible:outline-none disabled:cursor-default disabled:opacity-45"
      disabled={disabled}
      type="button"
      onClick={select}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        select();
      }}
    >
      {label}
    </button>
  );
}
