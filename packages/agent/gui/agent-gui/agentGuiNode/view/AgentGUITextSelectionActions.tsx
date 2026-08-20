import { createPortal } from "react-dom";

export interface AgentGUITextSelectionSnapshot {
  left: number;
  text: string;
  top: number;
}

export function readAgentGUITextSelection(
  root: HTMLElement
): AgentGUITextSelectionSnapshot | null {
  const ownerDocument = root.ownerDocument;
  const selection = ownerDocument.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  const viewportWidth = ownerDocument.defaultView?.innerWidth ?? 0;
  const center = rect.left + rect.width / 2;
  return {
    left: Math.min(Math.max(center, 132), Math.max(132, viewportWidth - 132)),
    text,
    top: Math.max(48, rect.top - 8)
  };
}

export function AgentGUITextSelectionActions({
  labels,
  snapshot,
  portalTarget,
  onAddToConversation,
  onAskInSide,
  onDismiss
}: {
  labels: { addToConversation: string; askInSide: string };
  snapshot: AgentGUITextSelectionSnapshot;
  portalTarget: HTMLElement;
  onAddToConversation: (text: string) => void;
  onAskInSide?: (text: string) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const run = (action: (text: string) => void) => {
    onDismiss();
    portalTarget.ownerDocument.getSelection()?.removeAllRanges();
    action(snapshot.text);
  };

  return createPortal(
    <div
      role="toolbar"
      aria-label={labels.addToConversation}
      className="nodrag fixed flex -translate-x-1/2 -translate-y-full overflow-hidden rounded-xl border border-[var(--border-1)] bg-[var(--background-fronted)] text-[14px] font-medium text-[var(--text-primary)] shadow-[var(--tsh-shell-shadow)] [-webkit-app-region:no-drag]"
      data-testid="agent-gui-text-selection-actions"
      style={{
        left: snapshot.left,
        top: snapshot.top,
        zIndex: "var(--z-popover)"
      }}
      onPointerDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="h-10 cursor-pointer px-4 hover:bg-[var(--background-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tutti-purple)]"
        onClick={() => run(onAddToConversation)}
      >
        {labels.addToConversation}
      </button>
      {onAskInSide ? (
        <button
          type="button"
          className="h-10 cursor-pointer border-l border-[var(--border-1)] px-4 hover:bg-[var(--background-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tutti-purple)]"
          onClick={() => run(onAskInSide)}
        >
          {labels.askInSide}
        </button>
      ) : null}
    </div>,
    portalTarget
  );
}
