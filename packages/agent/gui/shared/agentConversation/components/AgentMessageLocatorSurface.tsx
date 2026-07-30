import type {
  CSSProperties,
  FocusEventHandler,
  PointerEventHandler,
  Ref,
  RefObject
} from "react";
import type { AgentMessageLocatorItem } from "./agentTranscriptModel";
import type { AgentMessageLocatorLocateOptions } from "./agentMessageLocatorNavigation";

export const AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX = 30;
export const AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX = 36;

interface AgentMessageLocatorSurfaceProps {
  activeKey: string | null;
  closePanelSoon(): void;
  handleBlurCapture: FocusEventHandler<HTMLElement>;
  handleLocateItem(
    item: AgentMessageLocatorItem,
    options?: AgentMessageLocatorLocateOptions
  ): void;
  handlePointerDown: PointerEventHandler<HTMLDivElement>;
  handlePointerMove: PointerEventHandler<HTMLDivElement>;
  isPanelOpen: boolean;
  items: readonly AgentMessageLocatorItem[];
  label?: string;
  locatorRef: Ref<HTMLElement>;
  locatorViewportRef: Ref<HTMLDivElement>;
  openPanel(): void;
  panelActiveKey: string | null;
  panelRef: Ref<HTMLDivElement>;
  panelSelectedKey: string | null;
  setActiveKey(key: string): void;
  shouldRenderPanel: boolean;
  scrubTargetKey: string | null;
  stopPointerScrub: PointerEventHandler<HTMLDivElement>;
  suppressNextClickRef: RefObject<boolean>;
  unreadAgentResponseKeys: ReadonlySet<string>;
  viewportHeight: number;
  visibleFrame: { heightPx: number; topOffsetPx: number } | null;
  visibleKeys: ReadonlySet<string>;
}

export function AgentMessageLocatorSurface({
  activeKey,
  closePanelSoon,
  handleBlurCapture,
  handleLocateItem,
  handlePointerDown,
  handlePointerMove,
  isPanelOpen,
  items,
  label,
  locatorRef,
  locatorViewportRef,
  openPanel,
  panelActiveKey,
  panelRef,
  panelSelectedKey,
  setActiveKey,
  shouldRenderPanel,
  scrubTargetKey,
  stopPointerScrub,
  suppressNextClickRef,
  unreadAgentResponseKeys,
  viewportHeight,
  visibleFrame,
  visibleKeys
}: AgentMessageLocatorSurfaceProps): React.JSX.Element {
  const railHeight =
    (items.length - 1) * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  return (
    <nav
      ref={locatorRef}
      className="agent-gui-message-locator"
      aria-label={label ?? items[0]?.summary}
      data-agent-transcript-scroll-away-intent
      data-testid="agent-message-locator"
      onBlurCapture={handleBlurCapture}
      onFocusCapture={openPanel}
      onMouseEnter={openPanel}
      onMouseLeave={closePanelSoon}
      style={
        {
          "--agent-message-locator-height": `${railHeight}px`,
          "--agent-message-locator-viewport-height": `${viewportHeight}px`,
          ...(visibleFrame
            ? {
                "--agent-message-locator-visible-height": `${visibleFrame.heightPx}px`,
                "--agent-message-locator-visible-top-offset": `${visibleFrame.topOffsetPx}px`
              }
            : {})
        } as CSSProperties
      }
    >
      <div
        ref={locatorViewportRef}
        className="agent-gui-message-locator__viewport"
        data-testid="agent-message-locator-viewport"
        data-scrubbing={scrubTargetKey ? "true" : undefined}
        onLostPointerCapture={stopPointerScrub}
        onPointerCancel={stopPointerScrub}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopPointerScrub}
      >
        <div
          className="agent-gui-message-locator__content"
          style={
            {
              "--agent-message-locator-height": `${railHeight}px`
            } as CSSProperties
          }
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              className="agent-gui-message-locator__tick nodrag tsh-desktop-no-drag"
              style={
                {
                  "--agent-message-locator-position": `${
                    index * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX +
                    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX / 2
                  }px`
                } as CSSProperties
              }
              aria-label={item.summary}
              aria-current={visibleKeys.has(item.key) ? "true" : undefined}
              data-selected={visibleKeys.has(item.key) ? "true" : undefined}
              data-agent-message-locator-item-key={item.key}
              data-scrub-target={
                scrubTargetKey === item.key ? "true" : undefined
              }
              data-active={item.key === activeKey ? "true" : undefined}
              data-agent-message-locator-turn-group-index={item.turnGroupIndex}
              data-unread-agent-response={
                unreadAgentResponseKeys.has(item.key) ? "true" : undefined
              }
              onClick={() => {
                if (suppressNextClickRef.current) {
                  suppressNextClickRef.current = false;
                  return;
                }
                handleLocateItem(item, {
                  align: "top",
                  behavior: "smooth"
                });
              }}
              onFocus={() => setActiveKey(item.key)}
              onMouseEnter={() => setActiveKey(item.key)}
            >
              <span
                className="agent-gui-message-locator__dot"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </div>
      {shouldRenderPanel ? (
        <div
          ref={panelRef}
          className="agent-gui-message-locator__panel"
          role="tooltip"
          data-open={isPanelOpen ? "true" : undefined}
          data-testid="agent-message-locator-panel"
          onMouseEnter={openPanel}
          onMouseLeave={closePanelSoon}
        >
          {items.map((item) => (
            <button
              key={`panel:${item.key}`}
              type="button"
              className="agent-gui-message-locator__panel-item nodrag tsh-desktop-no-drag"
              aria-current={item.key === panelSelectedKey ? "true" : undefined}
              data-active={item.key === panelActiveKey ? "true" : undefined}
              data-selected={item.key === panelSelectedKey ? "true" : undefined}
              data-agent-message-locator-panel-key={item.key}
              onClick={() =>
                handleLocateItem(item, {
                  align: "top",
                  behavior: "smooth"
                })
              }
              onFocus={() => setActiveKey(item.key)}
              onMouseEnter={() => setActiveKey(item.key)}
            >
              <span className="agent-gui-message-locator__panel-item-text">
                {item.summary}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}

export function scrollMessageLocatorViewportToIndex(
  viewport: HTMLElement,
  selectedIndex: number,
  viewportHeight: number
): void {
  const selectedTop =
    selectedIndex * AGENT_MESSAGE_LOCATOR_ITEM_SPACING_PX -
    AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX / 2;
  const selectedBottom = selectedTop + AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  const padding = AGENT_MESSAGE_LOCATOR_HIT_SIZE_PX;
  const currentTop = viewport.scrollTop;
  const currentBottom = currentTop + viewportHeight;

  if (selectedTop < currentTop + padding) {
    viewport.scrollTop = Math.max(0, selectedTop - padding);
    return;
  }
  if (selectedBottom > currentBottom - padding) {
    viewport.scrollTop = Math.max(0, selectedBottom - viewportHeight + padding);
  }
}
