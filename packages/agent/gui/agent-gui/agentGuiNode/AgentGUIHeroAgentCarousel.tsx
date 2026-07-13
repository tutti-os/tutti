import {
  Component,
  createRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AgentGUIProvider } from "../../types";
import claudeVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/claude-vinyl.png";
import codexVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/codex-vinyl.png";
import cursorVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/cursor-vinyl.png";
import hermesVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/hermes-vinyl.png";
import openclawVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/openclaw-vinyl.png";
import opencodeVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/opencode-vinyl.png";
import tuttiVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/tutti-vinyl.png";
import type { AgentGUIAgentAvatarPresentation } from "./model/agentGuiAgentAvatarPresentation";
import { AgentGuiHeroCarouselScene } from "./agentGuiHeroCarouselScene";
import { AgentGUIVinylPlayer } from "./AgentGUIVinylPlayer";
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

interface AgentGUIHeroAgentCarouselState {
  centerIndex: number;
  coverImages: readonly (HTMLImageElement | null)[];
  iconKey: string;
  images: readonly (HTMLImageElement | null)[];
  imagesReady: boolean;
}

const CAROUSEL_WHEEL_STEP_THRESHOLD = 42;
const CAROUSEL_WHEEL_STEP_COOLDOWN_MS = 110;
const CAROUSEL_DRAG_STEP_PX = 52;

const AGENT_VINYL_COVER_BY_PROVIDER: Readonly<Record<string, string>> = {
  "claude-code": claudeVinylAssetUrl,
  codex: codexVinylAssetUrl,
  cursor: cursorVinylAssetUrl,
  hermes: hermesVinylAssetUrl,
  openclaw: openclawVinylAssetUrl,
  opencode: opencodeVinylAssetUrl,
  "tutti-agent": tuttiVinylAssetUrl
};

function activeAgentIndex(props: AgentGUIHeroAgentCarouselProps): number {
  if (!props.activeAgentTargetId) {
    return -1;
  }
  return props.items.findIndex(
    (item) => item.agentTargetId === props.activeAgentTargetId
  );
}

function carouselIconKey(
  items: readonly AgentGUIAgentAvatarPresentation[]
): string {
  return items
    .map(
      (item) =>
        `${item.agentTargetId}:${item.iconUrl}:${item.badge?.iconUrl ?? ""}`
    )
    .join("|");
}

function emptyPreloadedCarouselImages(
  length: number
): (HTMLImageElement | null)[] {
  return Array.from({ length }).map((): HTMLImageElement | null => null);
}

function preloadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const settle = (value: HTMLImageElement | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const resolveDecoded = (): void => {
      const decode = image.decode?.();
      if (decode) {
        void decode.then(() => settle(image)).catch(() => settle(image));
        return;
      }
      settle(image);
    };
    image.decoding = "async";
    image.loading = "eager";
    image.setAttribute("fetchpriority", "high");
    image.onload = resolveDecoded;
    image.onerror = () => settle(null);
    image.src = url;
    if (image.complete) {
      if (image.naturalWidth > 0) {
        resolveDecoded();
      } else {
        settle(null);
      }
    }
  });
}

async function preloadCarouselImages(
  item: AgentGUIAgentAvatarPresentation
): Promise<{
  cover: HTMLImageElement | null;
  icon: HTMLImageElement | null;
}> {
  const [icon, cover] = await Promise.all([
    preloadImage(item.iconUrl),
    preloadImage(AGENT_VINYL_COVER_BY_PROVIDER[item.provider] ?? null)
  ]);
  return { cover, icon };
}

// Three.js, ResizeObserver, image decoding, and a non-passive wheel listener
// form one imperative resource lifetime. A class component keeps that lifetime
// explicit instead of rebuilding it from several coordinating React effects.
export class AgentGUIHeroAgentCarousel extends Component<
  AgentGUIHeroAgentCarouselProps,
  AgentGUIHeroAgentCarouselState
> {
  private readonly stageRef = createRef<HTMLDivElement>();
  private readonly canvasRef = createRef<HTMLCanvasElement>();
  private scene: AgentGuiHeroCarouselScene | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private imagePreloadGeneration = 0;
  private wheelListenerAttached = false;
  private wheelAccumulated = 0;
  private wheelLastStepAt = 0;
  private dragState: { pointerId: number; anchorX: number } | null = null;
  private suppressClick = false;
  private pointerActivatedIndex: number | null = null;

  state: AgentGUIHeroAgentCarouselState = {
    centerIndex: Math.max(activeAgentIndex(this.props), 0),
    coverImages: [],
    iconKey: carouselIconKey(this.props.items),
    images: [],
    imagesReady: this.props.items.length === 0
  };

  componentDidMount(): void {
    this.preloadImages();
    this.syncWheelListener();
  }

  componentDidUpdate(previousProps: AgentGUIHeroAgentCarouselProps): void {
    const iconKey = carouselIconKey(this.props.items);
    if (iconKey !== this.state.iconKey) {
      this.disposeScene();
      this.setState(
        {
          centerIndex: Math.max(activeAgentIndex(this.props), 0),
          coverImages: [],
          iconKey,
          images: [],
          imagesReady: this.props.items.length === 0
        },
        () => this.preloadImages()
      );
      return;
    }

    if (
      previousProps.activeAgentTargetId !== this.props.activeAgentTargetId ||
      previousProps.items !== this.props.items
    ) {
      const activeIndex = activeAgentIndex(this.props);
      if (activeIndex >= 0 && activeIndex !== this.state.centerIndex) {
        this.setState({ centerIndex: activeIndex });
        this.scene?.moveTo(activeIndex);
      }
    }
    this.syncWheelListener();
  }

  componentWillUnmount(): void {
    this.imagePreloadGeneration += 1;
    this.removeWheelListener();
    this.disposeScene();
  }

  private interactive(): boolean {
    return this.props.onProviderSelect != null && this.props.items.length > 0;
  }

  private preloadImages(): void {
    const generation = ++this.imagePreloadGeneration;
    const items = this.props.items;
    if (items.length === 0) {
      this.setState({ coverImages: [], images: [], imagesReady: true });
      return;
    }
    if (typeof Image !== "function") {
      this.setState(
        {
          coverImages: emptyPreloadedCarouselImages(items.length),
          images: emptyPreloadedCarouselImages(items.length),
          imagesReady: true
        },
        () => this.mountScene()
      );
      return;
    }

    this.setState({
      coverImages: emptyPreloadedCarouselImages(items.length),
      images: emptyPreloadedCarouselImages(items.length),
      imagesReady: false
    });
    void Promise.all(items.map(preloadCarouselImages)).then((preloaded) => {
      if (
        generation !== this.imagePreloadGeneration ||
        carouselIconKey(this.props.items) !== this.state.iconKey
      ) {
        return;
      }
      this.setState(
        {
          coverImages: preloaded.map((entry) => entry.cover),
          images: preloaded.map((entry) => entry.icon),
          imagesReady: true
        },
        () => this.mountScene()
      );
    });
  }

  private mountScene(): void {
    const canvas = this.canvasRef.current;
    const stage = this.stageRef.current;
    if (
      this.scene ||
      !canvas ||
      !stage ||
      !this.state.imagesReady ||
      this.props.items.length === 0
    ) {
      return;
    }
    const scene = AgentGuiHeroCarouselScene.create({
      canvas,
      items: this.props.items,
      loadedCoverImages: this.state.coverImages,
      loadedImages: this.state.images,
      onSettle: this.handleSceneSettle
    });
    this.scene = scene;
    if (!scene) {
      return;
    }
    scene.moveTo(this.state.centerIndex, false);
    const resize = (): void => {
      const rect = stage.getBoundingClientRect();
      scene.setSize(rect.width, rect.height);
    };
    resize();
    this.resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    this.resizeObserver?.observe(stage);
  }

  private disposeScene(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scene?.dispose();
    this.scene = null;
  }

  private syncWheelListener(): void {
    const stage = this.stageRef.current;
    const shouldAttach = Boolean(stage && this.interactive());
    if (shouldAttach && !this.wheelListenerAttached) {
      stage!.addEventListener("wheel", this.handleWheel, { passive: false });
      this.wheelListenerAttached = true;
      return;
    }
    if (!shouldAttach) {
      this.removeWheelListener();
    }
  }

  private removeWheelListener(): void {
    if (!this.wheelListenerAttached) {
      return;
    }
    this.stageRef.current?.removeEventListener("wheel", this.handleWheel);
    this.wheelListenerAttached = false;
    this.wheelAccumulated = 0;
    this.wheelLastStepAt = 0;
  }

  private readonly handleSceneSettle = (index: number): void => {
    this.setState({ centerIndex: index });
    if (index !== activeAgentIndex(this.props)) {
      this.selectIndex(index);
    }
  };

  private selectIndex(index: number): void {
    const item = this.props.items[index];
    if (!item || !this.props.onProviderSelect) {
      return;
    }
    this.props.onProviderSelect({
      provider: item.provider,
      agentTargetId: item.targetId
    });
  }

  private stepBy(direction: 1 | -1): void {
    if (!this.scene || this.props.items.length <= 1) {
      return;
    }
    const centerIndex = this.scene.stepBy(direction);
    this.setState({ centerIndex });
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    const delta =
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    if (Math.sign(delta) !== Math.sign(this.wheelAccumulated)) {
      this.wheelAccumulated = 0;
    }
    this.wheelAccumulated += delta;
    const now = performance.now();
    if (
      Math.abs(this.wheelAccumulated) < CAROUSEL_WHEEL_STEP_THRESHOLD ||
      now - this.wheelLastStepAt < CAROUSEL_WHEEL_STEP_COOLDOWN_MS
    ) {
      return;
    }
    this.stepBy(this.wheelAccumulated > 0 ? 1 : -1);
    this.wheelAccumulated = 0;
    this.wheelLastStepAt = now;
  };

  private readonly handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!this.interactive() || event.button !== 0) {
      return;
    }
    this.dragState = { pointerId: event.pointerId, anchorX: event.clientX };
    this.suppressClick = false;
  };

  private readonly handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - this.dragState.anchorX;
    if (Math.abs(deltaX) < CAROUSEL_DRAG_STEP_PX) {
      return;
    }
    this.dragState.anchorX = event.clientX;
    this.suppressClick = true;
    this.pointerActivatedIndex = null;
    this.stepBy(deltaX < 0 ? 1 : -1);
  };

  private readonly handlePointerEnd = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (this.dragState?.pointerId === event.pointerId) {
      this.dragState = null;
    }
  };

  private readonly handleClickCapture = (event: ReactMouseEvent): void => {
    if (!this.suppressClick) {
      return;
    }
    this.suppressClick = false;
    this.pointerActivatedIndex = null;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    this.stepBy(event.key === "ArrowRight" ? 1 : -1);
  };

  private handleItemClick(index: number): void {
    this.setState({ centerIndex: index });
    this.scene?.moveTo(index);
    this.selectIndex(index);
  }

  private pickAt(
    event:
      | ReactMouseEvent<HTMLCanvasElement>
      | ReactPointerEvent<HTMLCanvasElement>
  ): number | null {
    const canvas = this.canvasRef.current;
    if (!this.scene || !canvas || !this.interactive()) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return this.scene.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height
    );
  }

  private activateOnPointerDown(index: number, event: ReactPointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    this.pointerActivatedIndex = index;
    this.handleItemClick(index);
  }

  private activateOnClick(index: number): void {
    if (this.pointerActivatedIndex === index) {
      this.pointerActivatedIndex = null;
      return;
    }
    this.pointerActivatedIndex = null;
    this.handleItemClick(index);
  }

  private readonly handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>
  ): void => {
    const index = this.pickAt(event);
    if (index !== null) {
      this.activateOnPointerDown(index, event);
    }
  };

  private readonly handleCanvasClick = (
    event: ReactMouseEvent<HTMLCanvasElement>
  ): void => {
    const index = this.pickAt(event);
    if (index !== null) {
      this.activateOnClick(index);
    }
  };

  private readonly handleCanvasHover = (
    event: ReactPointerEvent<HTMLCanvasElement>
  ): void => {
    const canvas = this.canvasRef.current;
    if (!this.scene || !canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const hoveredIndex = this.scene.hover(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height
    );
    canvas.style.cursor = hoveredIndex !== null ? "pointer" : "";
  };

  private readonly handleCanvasLeave = (): void => {
    this.scene?.clearHover();
    if (this.canvasRef.current) {
      this.canvasRef.current.style.cursor = "";
    }
  };

  render(): React.JSX.Element {
    const interactive = this.interactive();
    return (
      <div
        ref={this.stageRef}
        aria-hidden={interactive ? undefined : "true"}
        aria-label={interactive ? this.props.providerSelectLabel : undefined}
        role={interactive ? "group" : undefined}
        className={styles.emptyHeroCarousel}
        data-icons-ready={this.state.imagesReady}
        onKeyDown={interactive ? this.handleKeyDown : undefined}
        onPointerDown={interactive ? this.handlePointerDown : undefined}
        onPointerMove={interactive ? this.handlePointerMove : undefined}
        onPointerUp={interactive ? this.handlePointerEnd : undefined}
        onPointerCancel={interactive ? this.handlePointerEnd : undefined}
        onClickCapture={interactive ? this.handleClickCapture : undefined}
      >
        <AgentGUIVinylPlayer
          selectedAgent={
            this.props.items[this.state.centerIndex] ??
            this.props.items[0] ??
            null
          }
          isPlaying
        />
        <canvas
          ref={this.canvasRef}
          aria-hidden="true"
          className={styles.emptyHeroCarouselCanvas}
          onClick={interactive ? this.handleCanvasClick : undefined}
          onPointerDown={interactive ? this.handleCanvasPointerDown : undefined}
          onPointerMove={interactive ? this.handleCanvasHover : undefined}
          onPointerLeave={interactive ? this.handleCanvasLeave : undefined}
        />
        {this.props.items.map((item, index) => {
          const isCenter = index === this.state.centerIndex;
          const key = `${item.agentTargetId}:${item.iconUrl}`;
          if (this.props.onProviderSelect) {
            const itemLabel = item.badge?.label
              ? `${item.label}, ${item.badge.label}`
              : item.label;
            const label = this.props.providerSelectLabel
              ? `${this.props.providerSelectLabel}: ${itemLabel}`
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
                onPointerDown={(event) =>
                  this.activateOnPointerDown(index, event)
                }
                onClick={() => this.activateOnClick(index)}
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
}
