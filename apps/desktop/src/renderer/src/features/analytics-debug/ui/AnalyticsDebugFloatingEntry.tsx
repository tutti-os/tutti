import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { useService } from "@tutti-os/infra/di";
import {
  Badge,
  Button,
  CloseIcon,
  DeleteIcon,
  HealthIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { IAnalyticsDebugEventService } from "../services/analyticsDebugEventService.interface";
import {
  hasAnalyticsDebugFloatingDragMoved,
  resolveAnalyticsDebugFloatingPosition,
  type AnalyticsDebugPosition
} from "./analyticsDebugFloatingPosition";

interface DragSession {
  dragging: boolean;
  floatingSize: {
    height: number;
    width: number;
  };
  pointerStart: {
    x: number;
    y: number;
  };
  startPosition: AnalyticsDebugPosition;
}

export function AnalyticsDebugFloatingEntry() {
  const { t } = useTranslation();
  const service = useService(IAnalyticsDebugEventService);
  const [position, setPosition] = useState<AnalyticsDebugPosition | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const dragSessionRef = useRef<DragSession | null>(null);
  const suppressNextClickRef = useRef(false);
  const events = useSyncExternalStore(
    service.subscribe.bind(service),
    service.getSnapshot.bind(service),
    service.getSnapshot.bind(service)
  );
  const orderedEvents = useMemo(() => [...events].reverse(), [events]);
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      dragSessionRef.current = {
        dragging: false,
        floatingSize: {
          height: rect.height,
          width: rect.width
        },
        pointerStart: {
          x: event.clientX,
          y: event.clientY
        },
        startPosition: {
          left: rect.left,
          top: rect.top
        }
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    []
  );
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const dragSession = dragSessionRef.current;
      if (!dragSession) {
        return;
      }

      const pointerCurrent = {
        x: event.clientX,
        y: event.clientY
      };
      const dragging =
        dragSession.dragging ||
        hasAnalyticsDebugFloatingDragMoved({
          pointerCurrent,
          pointerStart: dragSession.pointerStart
        });
      if (!dragging) {
        return;
      }

      dragSession.dragging = true;
      suppressNextClickRef.current = true;
      setPosition(
        resolveAnalyticsDebugFloatingPosition({
          floatingSize: dragSession.floatingSize,
          pointerCurrent,
          pointerStart: dragSession.pointerStart,
          startPosition: dragSession.startPosition,
          viewport: {
            height: window.innerHeight,
            width: window.innerWidth
          }
        })
      );
    },
    []
  );
  const handlePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      dragSessionRef.current = null;
    },
    []
  );
  const handleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!suppressNextClickRef.current) {
        return;
      }

      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    []
  );

  return (
    <div
      className="fixed right-4 bottom-4 z-[var(--z-dialog-popover)]"
      data-analytics-debug-floating-root="true"
      style={
        position
          ? {
              bottom: "auto",
              left: position.left,
              right: "auto",
              top: position.top
            }
          : undefined
      }
    >
      <Popover open={panelOpen} onOpenChange={setPanelOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label={t("workspace.analyticsDebug.open")}
            className="relative size-11 touch-none rounded-full border border-[var(--border-1)] bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-soft hover:bg-[var(--background-hover)]"
            onClickCapture={handleClickCapture}
            onPointerCancel={handlePointerEnd}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            size="icon-lg"
            variant="outline"
          >
            <HealthIcon size={18} />
            {events.length > 0 ? (
              <span className="absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full bg-[var(--accent-bg)] px-1 text-[10px] leading-5 text-[var(--accent)]">
                {events.length}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(420px,calc(100vw-32px))] gap-0 p-0"
          data-analytics-debug-floating-panel="true"
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          side="top"
          sideOffset={10}
          style={{ zIndex: "var(--z-dialog-popover)" }}
        >
          <div className="flex items-start justify-between gap-2 border-b border-[var(--border-1)] px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                {t("workspace.analyticsDebug.title")}
              </div>
              <div className="text-[11px] text-[var(--text-tertiary)]">
                {t("workspace.analyticsDebug.count", {
                  count: events.length
                })}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                disabled={events.length === 0}
                onClick={() => service.clear()}
                size="sm"
                variant="ghost"
              >
                <DeleteIcon size={14} />
                {t("workspace.analyticsDebug.clear")}
              </Button>
              <Button
                aria-label={t("workspace.analyticsDebug.close")}
                onClick={() => setPanelOpen(false)}
                size="icon-sm"
                title={t("workspace.analyticsDebug.close")}
                type="button"
                variant="ghost"
              >
                <CloseIcon className="size-4" />
              </Button>
            </div>
          </div>
          <ScrollArea className="h-[min(420px,calc(100vh-120px))]">
            {orderedEvents.length === 0 ? (
              <div className="px-3 py-8 text-center text-[13px] text-[var(--text-tertiary)]">
                {t("workspace.analyticsDebug.empty")}
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-1)]">
                {orderedEvents.map((event, index) => (
                  <article
                    className="px-3 py-2.5"
                    key={`${event.name}-${event.client_ts}-${index}`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {event.name}
                      </div>
                      <Badge className="shrink-0" variant="secondary">
                        {formatEventTime(event.client_ts)}
                      </Badge>
                    </div>
                    <div className="mb-1 text-[11px] text-[var(--text-tertiary)]">
                      {t("workspace.analyticsDebug.clientTimestamp", {
                        value: event.client_ts
                      })}
                    </div>
                    <pre className="max-w-full whitespace-pre-wrap break-words rounded-md bg-[var(--transparency-block)] p-2 text-[11px] leading-4 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                      {formatParams(event.params)}
                    </pre>
                  </article>
                ))}
              </div>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function formatEventTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "--:--:--";
  }

  return new Date(timestamp).toLocaleTimeString();
}

function formatParams(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "{}";
  }

  return JSON.stringify(params, null, 2);
}
