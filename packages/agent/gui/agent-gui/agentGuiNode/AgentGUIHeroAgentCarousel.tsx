import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AgentGUIProvider } from "../../types";
import type { AgentGUIAgentAvatarPresentation } from "./model/agentGuiAgentAvatarPresentation";
import { AgentGuiHeroCarouselScene } from "./agentGuiHeroCarouselScene";
import styles from "./AgentGUINode.styles";

export interface AgentGUIHeroCarouselSelectInput {
  provider: AgentGUIProvider;
  agentTargetId?: string | null;
}

interface AgentGUIHeroAgentCarouselProps {
  activeAgentTargetId?: string | null;
  items: readonly AgentGUIAgentAvatarPresentation[];
  onProviderSelect?: (input: AgentGUIHeroCarouselSelectInput) => void;
  providerSelectLabel?: string;
}

const CAROUSEL_WHEEL_STEP_THRESHOLD = 42;
const CAROUSEL_WHEEL_STEP_COOLDOWN_MS = 110;
const CAROUSEL_DRAG_STEP_PX = 52;

interface AgentGUIHeroCarouselImagePreloadState {
  images: readonly (HTMLImageElement | null)[];
  ready: boolean;
}

function emptyPreloadedCarouselImages(
  length: number
): (HTMLImageElement | null)[] {
  return Array.from({ length }).map((): HTMLImageElement | null => null);
}

function useAgentGUIHeroCarouselImages(
  items: readonly AgentGUIAgentAvatarPresentation[],
  iconKey: string
): AgentGUIHeroCarouselImagePreloadState {
  const [preloadState, setPreloadState] =
    useState<AgentGUIHeroCarouselImagePreloadState>({
      images: [],
      ready: items.length === 0
    });

  useEffect(() => {
    if (items.length === 0) {
      setPreloadState({ images: [], ready: true });
      return;
    }
    if (typeof Image !== "function") {
      setPreloadState({
        images: emptyPreloadedCarouselImages(items.length),
        ready: true
      });
      return;
    }

    let cancelled = false;
    setPreloadState({
      images: emptyPreloadedCarouselImages(items.length),
      ready: false
    });

    void Promise.all(
      items.map(
        (item) =>
          new Promise<HTMLImageElement | null>((resolve) => {
            const image = new Image();
            const resolveDecoded = (): void => {
              const decode = image.decode?.();
              if (decode) {
                void decode
                  .then(() => resolve(image))
                  .catch(() => resolve(image));
                return;
              }
              resolve(image);
            };
            image.decoding = "async";
            image.loading = "eager";
            image.setAttribute("fetchpriority", "high");
            image.onload = () => {
              resolveDecoded();
            };
            image.onerror = () => resolve(null);
            image.src = item.iconUrl;
            if (image.complete) {
              if (image.naturalWidth > 0) {
                resolveDecoded();
              } else {
                resolve(null);
              }
            }
          })
      )
    ).then((images) => {
      if (!cancelled) {
        setPreloadState({ images, ready: true });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [iconKey]);

  return preloadState;
}

// Empty-hero agent switcher for the "All" tab: a ring of same-sized agent
// records rendered with three.js (see agentGuiHeroCarouselScene) so records
// farther around the ring genuinely shrink and fade with perspective.
// Wheel, drag, and arrow keys spin the ring; the centered agent commits once
// the spin settles; clicking a tile (canvas raycast or the visually-hidden
// accessible buttons) selects it immediately.
export const AgentGUIHeroAgentCarousel = memo(
  function AgentGUIHeroAgentCarousel({
    activeAgentTargetId,
    items,
    onProviderSelect,
    providerSelectLabel
  }: AgentGUIHeroAgentCarouselProps): React.JSX.Element {
    const activeIconIndex = useMemo(
      () =>
        !activeAgentTargetId
          ? -1
          : items.findIndex(
              (item) => item.agentTargetId === activeAgentTargetId
            ),
      [activeAgentTargetId, items]
    );
    const [centerIndex, setCenterIndex] = useState(
      activeIconIndex >= 0 ? activeIconIndex : 0
    );
    const centerIndexRef = useRef(centerIndex);
    centerIndexRef.current = centerIndex;
    const activeIconIndexRef = useRef(activeIconIndex);
    activeIconIndexRef.current = activeIconIndex;
    const interactive = onProviderSelect != null && items.length > 0;

    const selectIndex = useCallback(
      (index: number) => {
        const item = items[index];
        if (!item || !onProviderSelect) {
          return;
        }
        onProviderSelect({
          provider: item.provider,
          agentTargetId: item.targetId
        });
      },
      [items, onProviderSelect]
    );
    const selectIndexRef = useRef(selectIndex);
    selectIndexRef.current = selectIndex;

    const stageRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<AgentGuiHeroCarouselScene | null>(null);
    const iconKey = items
      .map(
        (item) =>
          `${item.agentTargetId}:${item.iconUrl}:${item.badge?.iconUrl ?? ""}`
      )
      .join("|");
    const carouselImages = useAgentGUIHeroCarouselImages(items, iconKey);

    useEffect(() => {
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!canvas || !stage || !carouselImages.ready) {
        return;
      }
      const scene = AgentGuiHeroCarouselScene.create({
        canvas,
        items,
        loadedImages: carouselImages.images,
        onSettle: (index) => {
          centerIndexRef.current = index;
          setCenterIndex(index);
          // The ring can settle on the already-active agent (external syncs,
          // re-centering); only user-driven landings commit a switch.
          if (index !== activeIconIndexRef.current) {
            selectIndexRef.current(index);
          }
        }
      });
      sceneRef.current = scene;
      if (!scene) {
        return;
      }
      scene.moveTo(centerIndexRef.current, false);
      const resize = (): void => {
        const rect = stage.getBoundingClientRect();
        scene.setSize(rect.width, rect.height);
      };
      resize();
      const observer =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(resize)
          : null;
      observer?.observe(stage);
      return () => {
        observer?.disconnect();
        scene.dispose();
        sceneRef.current = null;
      };
      // The scene is rebuilt only when the icon set itself changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [carouselImages.images, carouselImages.ready, iconKey]);

    // Provider selection can also come from the rail or title control. Keep
    // that selected agent in the carousel's center so the spinning record and
    // the composer below always describe the same target.
    useEffect(() => {
      if (activeIconIndex >= 0 && activeIconIndex !== centerIndexRef.current) {
        centerIndexRef.current = activeIconIndex;
        setCenterIndex(activeIconIndex);
        sceneRef.current?.moveTo(activeIconIndex);
      }
    }, [activeIconIndex]);

    const stepBy = useCallback(
      (direction: 1 | -1) => {
        const scene = sceneRef.current;
        if (!scene || items.length <= 1) {
          return;
        }
        const next = scene.stepBy(direction);
        centerIndexRef.current = next;
        setCenterIndex(next);
      },
      [items.length]
    );
    const stepByRef = useRef(stepBy);
    stepByRef.current = stepBy;

    // Wheel needs a non-passive listener to consume horizontal trackpad pans
    // (and vertical wheel ticks) instead of scrolling any ancestor.
    useEffect(() => {
      const stage = stageRef.current;
      if (!stage || !interactive) {
        return;
      }
      let accumulated = 0;
      let lastStepAt = 0;
      const handleWheel = (event: WheelEvent): void => {
        const delta =
          Math.abs(event.deltaX) >= Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        if (delta === 0) {
          return;
        }
        event.preventDefault();
        if (Math.sign(delta) !== Math.sign(accumulated)) {
          accumulated = 0;
        }
        accumulated += delta;
        const now = performance.now();
        if (
          Math.abs(accumulated) < CAROUSEL_WHEEL_STEP_THRESHOLD ||
          now - lastStepAt < CAROUSEL_WHEEL_STEP_COOLDOWN_MS
        ) {
          return;
        }
        stepByRef.current(accumulated > 0 ? 1 : -1);
        accumulated = 0;
        lastStepAt = now;
      };
      stage.addEventListener("wheel", handleWheel, { passive: false });
      return () => stage.removeEventListener("wheel", handleWheel);
    }, [interactive]);

    const dragStateRef = useRef<{ pointerId: number; anchorX: number } | null>(
      null
    );
    const suppressClickRef = useRef(false);
    const pointerActivatedIndexRef = useRef<number | null>(null);
    const handlePointerDown = (
      event: ReactPointerEvent<HTMLDivElement>
    ): void => {
      if (!interactive || event.button !== 0) {
        return;
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        anchorX: event.clientX
      };
      suppressClickRef.current = false;
    };
    const handlePointerMove = (
      event: ReactPointerEvent<HTMLDivElement>
    ): void => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const deltaX = event.clientX - drag.anchorX;
      if (Math.abs(deltaX) < CAROUSEL_DRAG_STEP_PX) {
        return;
      }
      drag.anchorX = event.clientX;
      suppressClickRef.current = true;
      pointerActivatedIndexRef.current = null;
      // Dragging left pulls the next agent (to the right) into the center.
      stepBy(deltaX < 0 ? 1 : -1);
    };
    const handlePointerEnd = (
      event: ReactPointerEvent<HTMLDivElement>
    ): void => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null;
      }
    };
    const handleClickCapture = (event: ReactMouseEvent): void => {
      if (!suppressClickRef.current) {
        return;
      }
      suppressClickRef.current = false;
      pointerActivatedIndexRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      stepBy(event.key === "ArrowRight" ? 1 : -1);
    };

    const handleItemClick = (index: number): void => {
      centerIndexRef.current = index;
      setCenterIndex(index);
      sceneRef.current?.moveTo(index);
      selectIndex(index);
    };

    const pickAt = (
      event:
        | ReactMouseEvent<HTMLCanvasElement>
        | ReactPointerEvent<HTMLCanvasElement>
    ): number | null => {
      const scene = sceneRef.current;
      const canvas = canvasRef.current;
      if (!scene || !canvas || !interactive) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      return scene.pick(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height
      );
    };

    const activateOnPointerDown = (
      index: number,
      event: ReactPointerEvent
    ): void => {
      if (event.button !== 0) {
        return;
      }
      pointerActivatedIndexRef.current = index;
      handleItemClick(index);
    };

    const activateOnClick = (index: number): void => {
      if (pointerActivatedIndexRef.current === index) {
        pointerActivatedIndexRef.current = null;
        return;
      }
      pointerActivatedIndexRef.current = null;
      handleItemClick(index);
    };

    const handleCanvasPointerDown = (
      event: ReactPointerEvent<HTMLCanvasElement>
    ): void => {
      const index = pickAt(event);
      if (index !== null) {
        activateOnPointerDown(index, event);
      }
    };

    const handleCanvasClick = (
      event: ReactMouseEvent<HTMLCanvasElement>
    ): void => {
      const index = pickAt(event);
      if (index !== null) {
        activateOnClick(index);
      }
    };

    const handleCanvasHover = (
      event: ReactPointerEvent<HTMLCanvasElement>
    ): void => {
      const scene = sceneRef.current;
      const canvas = canvasRef.current;
      if (!scene || !canvas) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const hoveredIndex = scene.hover(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height
      );
      canvas.style.cursor = hoveredIndex !== null ? "pointer" : "";
    };

    const handleCanvasLeave = (): void => {
      sceneRef.current?.clearHover();
      if (canvasRef.current) {
        canvasRef.current.style.cursor = "";
      }
    };

    return (
      <div
        ref={stageRef}
        aria-hidden={interactive ? undefined : "true"}
        aria-label={interactive ? providerSelectLabel : undefined}
        role={interactive ? "group" : undefined}
        className={styles.emptyHeroCarousel}
        data-icons-ready={carouselImages.ready}
        onKeyDown={interactive ? handleKeyDown : undefined}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? handlePointerEnd : undefined}
        onPointerCancel={interactive ? handlePointerEnd : undefined}
        onClickCapture={interactive ? handleClickCapture : undefined}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={styles.emptyHeroCarouselCanvas}
          onClick={interactive ? handleCanvasClick : undefined}
          onPointerDown={interactive ? handleCanvasPointerDown : undefined}
          onPointerMove={interactive ? handleCanvasHover : undefined}
          onPointerLeave={interactive ? handleCanvasLeave : undefined}
        />
        {items.map((item, index) => {
          // Visually-hidden switchers keep the ring reachable by keyboard,
          // screen readers, and DOM-level tests; visuals live on the canvas.
          const isCenter = index === centerIndex;
          const key = `${item.agentTargetId}:${item.iconUrl}`;
          if (onProviderSelect) {
            const itemLabel = item.badge?.label
              ? `${item.label}, ${item.badge.label}`
              : item.label;
            const label = providerSelectLabel
              ? `${providerSelectLabel}: ${itemLabel}`
              : itemLabel;
            return (
              <button
                key={key}
                type="button"
                className={styles.emptyHeroCarouselItem}
                data-agent-target-id={item.agentTargetId}
                data-provider={item.provider}
                data-provider-active={isCenter}
                aria-label={label}
                aria-pressed={isCenter}
                title={item.label}
                onPointerDown={(event) => activateOnPointerDown(index, event)}
                onClick={() => activateOnClick(index)}
              >
                {item.label}
              </button>
            );
          }
          return (
            <span
              key={key}
              className={styles.emptyHeroCarouselItem}
              data-provider={item.provider}
              data-provider-active={isCenter}
            />
          );
        })}
      </div>
    );
  }
);
