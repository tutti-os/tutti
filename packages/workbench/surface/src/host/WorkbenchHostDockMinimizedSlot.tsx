import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { WorkbenchDockPreviewCache } from "../react/dockPreviewCache.ts";
import {
  minimizedDockPreviewFreezeKey,
  WorkbenchHostDockMinimizedNodePreview
} from "./WorkbenchHostDockMinimizedPreview.tsx";
import type { WorkbenchHostDockPresence } from "./dockPresence.ts";
import type {
  WorkbenchMinimizedDockNode,
  WorkbenchMinimizedDockSlot
} from "./minimizedDockSlots.ts";
import { dockLabelTooltipTarget } from "./useWorkbenchHostDockOverlays.ts";
import type { WorkbenchDockWallpaperTone } from "./useWorkbenchHostDockWallpaperTones.ts";
import type { WorkbenchDockPreviewContent } from "./types.ts";

interface WorkbenchHostDockMinimizedOverlayController {
  clearLabelTooltipOpenTimer: () => void;
  closeLabelTooltipImmediate: (targetKey?: string) => void;
  dockMeasureRef: RefObject<HTMLDivElement | null>;
  scheduleLabelTooltipAfterRest: (
    target: { key: string; label: string },
    anchorKey: string
  ) => void;
  scheduleLabelTooltipAtPointAfterRest: (
    clientX: number,
    clientY: number
  ) => void;
  showLabelTooltip: (
    target: { key: string; label: string },
    anchorKey: string,
    anchorElement: HTMLElement
  ) => void;
}

export function WorkbenchHostDockMinimizedSlot({
  activeStackPopup,
  capturePreview,
  collapsing,
  dockPreviewCache,
  isPendingNode,
  minimizedWindowsLabel,
  nodeLaunchLabel,
  onBeginStackInteraction,
  onNodeActivate,
  onNodePointerDown,
  onToggleStackPopup,
  overlay,
  presence,
  promotedNodeId,
  providePreviewForNode,
  registerDockSlot,
  slot,
  stackDispatching,
  wallpaperTone,
  workspaceId
}: {
  activeStackPopup: boolean;
  capturePreview: (
    node: WorkbenchMinimizedDockNode
  ) => Promise<string | null> | string | null;
  collapsing: boolean;
  dockPreviewCache?: WorkbenchDockPreviewCache;
  isPendingNode: (nodeId: string) => boolean;
  minimizedWindowsLabel: string;
  nodeLaunchLabel: (title: string) => string;
  onBeginStackInteraction: () => void;
  onNodeActivate: (nodeId: string, anchorKey: string) => void;
  onNodePointerDown: (nodeId: string, anchorKey: string) => void;
  onToggleStackPopup: (anchorRect: {
    dockRight: number;
    height: number;
    left: number;
    top: number;
    width: number;
  }) => void;
  overlay: WorkbenchHostDockMinimizedOverlayController;
  presence: WorkbenchHostDockPresence;
  promotedNodeId: string | null;
  providePreviewForNode: (
    node: WorkbenchMinimizedDockNode
  ) =>
    | ((node: WorkbenchMinimizedDockNode) => WorkbenchDockPreviewContent | null)
    | undefined;
  registerDockSlot: (
    anchorKey: string
  ) => (element: HTMLElement | null) => void;
  slot: WorkbenchMinimizedDockSlot;
  stackDispatching: boolean;
  wallpaperTone?: WorkbenchDockWallpaperTone;
  workspaceId: string;
}) {
  if (slot.kind === "stack") {
    const labelTooltip = dockLabelTooltipTarget(
      `minimized-stack:${slot.anchorKey}`,
      minimizedWindowsLabel
    );
    return (
      <span
        ref={registerDockSlot(slot.anchorKey)}
        className="desktop-dock__slot desktop-dock__slot--minimized"
        data-desktop-dock-anchor-key={slot.anchorKey}
        data-desktop-dock-slot="true"
        data-dock-label-tooltip-key={labelTooltip.key}
        data-dock-label-tooltip-label={labelTooltip.label}
        data-node-state="minimized"
        data-popup-active={activeStackPopup ? true : undefined}
        data-presence={presence}
        data-section-id="minimized"
        data-stack-dispatching={stackDispatching ? "true" : undefined}
        data-wallpaper-tone={wallpaperTone}
        {...minimizedTooltipHandlers(labelTooltip, slot.anchorKey, overlay)}
      >
        <span
          aria-expanded={activeStackPopup ? true : undefined}
          aria-haspopup="dialog"
          aria-label={minimizedWindowsLabel}
          className="desktop-dock__btn desktop-dock__minimized-btn"
          data-interactive="true"
          role="button"
          tabIndex={0}
          onKeyDown={activateDockButtonFromKeyboard}
          onPointerDown={(event) => {
            if (event.button === 0) {
              onBeginStackInteraction();
            }
          }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const dockRect =
              overlay.dockMeasureRef.current?.getBoundingClientRect();
            onToggleStackPopup({
              dockRight: Math.max(rect.right, dockRect?.right ?? rect.right),
              height: rect.height,
              left: rect.left,
              top: rect.top,
              width: rect.width
            });
          }}
        >
          <span
            className="desktop-dock__minimized-stack-icon"
            data-desktop-dock-icon-shell="true"
            data-stack-folded={slot.nodes.length > 1 ? "true" : undefined}
            aria-hidden
          >
            {Array.from(
              {
                length:
                  slot.nodes.length > 1 ? 3 : Math.min(slot.nodes.length, 1)
              },
              (_, index) => {
                const node = slot.nodes[index];
                if (index === 0 && node) {
                  return (
                    <WorkbenchHostDockMinimizedNodePreview
                      key={minimizedDockPreviewFreezeKey(node)}
                      capturePreview={capturePreview}
                      className={`desktop-dock__minimized-stack-layer desktop-dock__minimized-stack-layer--${index}`}
                      dockPreviewCache={dockPreviewCache}
                      node={node}
                      providePreview={providePreviewForNode(node)}
                      workspaceId={workspaceId}
                    />
                  );
                }
                return (
                  <span
                    key={`${slot.anchorKey}-stack-back-${index}`}
                    aria-hidden="true"
                    className={`desktop-dock__minimized-preview desktop-dock__minimized-stack-layer desktop-dock__minimized-stack-layer--${index} desktop-dock__minimized-stack-layer-back`}
                  />
                );
              }
            )}
            <span className="desktop-dock__count-badge">
              {slot.nodes.length}
            </span>
          </span>
        </span>
      </span>
    );
  }

  const { node } = slot;
  const pending = isPendingNode(node.id);
  const labelTooltip = dockLabelTooltipTarget(
    `minimized-node:${node.id}`,
    node.title
  );
  return (
    <span
      ref={registerDockSlot(slot.anchorKey)}
      className="desktop-dock__slot desktop-dock__slot--minimized"
      data-collapsing={collapsing ? "true" : undefined}
      data-desktop-dock-anchor-key={slot.anchorKey}
      data-desktop-dock-slot="true"
      data-dock-label-tooltip-key={labelTooltip.key}
      data-dock-label-tooltip-label={labelTooltip.label}
      data-node-state="minimized"
      data-pending-minimize={pending ? "true" : undefined}
      data-presence={presence}
      data-promoted-from-stack={promotedNodeId === node.id ? "true" : undefined}
      data-section-id="minimized"
      data-wallpaper-tone={wallpaperTone}
      {...minimizedTooltipHandlers(labelTooltip, slot.anchorKey, overlay)}
    >
      <span
        aria-label={nodeLaunchLabel(node.title)}
        aria-disabled={pending ? true : undefined}
        className="desktop-dock__btn desktop-dock__minimized-btn"
        data-interactive={pending ? "false" : "true"}
        role="button"
        tabIndex={pending ? -1 : 0}
        onKeyDown={(event) => activateDockButtonFromKeyboard(event, pending)}
        onPointerDown={(event) => {
          if (event.button === 0 && !pending) {
            onNodePointerDown(node.id, slot.anchorKey);
          }
        }}
        onClick={() => {
          if (!pending) {
            onNodeActivate(node.id, slot.anchorKey);
          }
        }}
      >
        <WorkbenchHostDockMinimizedNodePreview
          key={minimizedDockPreviewFreezeKey(node)}
          capturePreview={pending ? undefined : capturePreview}
          deferPreview={pending}
          dockPreviewCache={pending ? undefined : dockPreviewCache}
          node={node}
          providePreview={pending ? undefined : providePreviewForNode(node)}
          workspaceId={workspaceId}
        />
      </span>
    </span>
  );
}

function activateDockButtonFromKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  disabled = false
) {
  if (disabled || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }
  event.preventDefault();
  event.currentTarget.click();
}

function minimizedTooltipHandlers(
  target: { key: string; label: string },
  anchorKey: string,
  overlay: WorkbenchHostDockMinimizedOverlayController
) {
  return {
    onBlur: (event: React.FocusEvent<HTMLSpanElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        overlay.closeLabelTooltipImmediate(target.key);
      }
    },
    onFocus: (event: React.FocusEvent<HTMLSpanElement>) => {
      overlay.showLabelTooltip(target, anchorKey, event.currentTarget);
    },
    onPointerEnter: () => {
      overlay.scheduleLabelTooltipAfterRest(target, anchorKey);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLSpanElement>) => {
      overlay.clearLabelTooltipOpenTimer();
      overlay.closeLabelTooltipImmediate(target.key);
      const relatedTarget = event.relatedTarget;
      if (
        relatedTarget instanceof Node &&
        overlay.dockMeasureRef.current?.contains(relatedTarget)
      ) {
        overlay.scheduleLabelTooltipAtPointAfterRest(
          event.clientX,
          event.clientY
        );
      }
    }
  };
}
