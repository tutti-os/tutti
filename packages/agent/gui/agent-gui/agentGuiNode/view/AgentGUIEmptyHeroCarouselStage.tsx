import { Component, type ReactNode } from "react";
import type { AgentGUIAgentAvatarPresentation } from "../model/agentGuiAgentAvatarPresentation";
import type { AgentGUINodeViewProps } from "../AgentGUINodeView";
import { AgentGUIHeroAgentCarousel } from "../AgentGUIHeroAgentCarousel";
import styles from "../AgentGUINode.styles";

interface AgentGUIEmptyHeroCarouselStageProps {
  activeAgentTargetId?: string | null;
  children: ReactNode;
  items: readonly AgentGUIAgentAvatarPresentation[];
  onProviderSelect?: AgentGUINodeViewProps["actions"]["selectHomeComposerAgentTarget"];
  providerSelectLabel: string;
}

// Keep the carousel outside the ready/readiness-gate branch. Runtime
// readiness changes must not replace the WebGL canvas or reset its position.
export class AgentGUIEmptyHeroCarouselStage extends Component<AgentGUIEmptyHeroCarouselStageProps> {
  private animationFrame: number | null = null;
  private layer: HTMLDivElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private stage: HTMLDivElement | null = null;

  componentDidMount(): void {
    this.startAlignment();
  }

  componentDidUpdate(): void {
    this.startAlignment();
  }

  componentWillUnmount(): void {
    this.stopAlignment();
  }

  render(): React.JSX.Element {
    const {
      activeAgentTargetId,
      children,
      items,
      onProviderSelect,
      providerSelectLabel
    } = this.props;
    const hasCarousel = items.length > 1;

    return (
      <div ref={this.setStage} className={styles.emptyHeroCarouselStage}>
        {hasCarousel ? (
          <div ref={this.setLayer} className={styles.emptyHeroCarouselLayer}>
            <AgentGUIHeroAgentCarousel
              activeAgentTargetId={activeAgentTargetId}
              items={items}
              onProviderSelect={onProviderSelect}
              providerSelectLabel={providerSelectLabel}
            />
          </div>
        ) : null}
        {children}
      </div>
    );
  }

  // The floating layer must sit exactly on the body's placeholder slot. A
  // fixed offset from the stage center only matches the slot for one body
  // height; narrow panes wrap the title and grow the composer, which
  // re-centers the body and slides the slot upward, so measure the slot's
  // real offset instead and let the CSS fallback cover the pre-measure
  // paint. The body resize observer catches height-only changes (wrapping
  // text, growing composer) that never resize the stage itself, and the
  // mutation observer re-attaches it when the ready/gated branch swaps the
  // body subtree.
  private startAlignment(): void {
    if (this.props.items.length <= 1 || !this.stage || !this.layer) {
      this.stopAlignment();
      return;
    }

    if (!this.resizeObserver && typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(this.scheduleAlignment);
    }
    if (!this.mutationObserver && typeof MutationObserver === "function") {
      this.mutationObserver = new MutationObserver(() => {
        this.observeLayoutRoots();
        this.scheduleAlignment();
      });
      this.mutationObserver.observe(this.stage, {
        childList: true,
        subtree: true
      });
    }
    this.observeLayoutRoots();
    this.syncAlignment();
  }

  private stopAlignment(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
  }

  private observeLayoutRoots(): void {
    if (!this.stage) {
      return;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(this.stage);
    const body = this.stage.querySelector(`.${styles.emptyHeroBody}`);
    if (body) {
      this.resizeObserver?.observe(body);
    }
  }

  private readonly scheduleAlignment = (): void => {
    if (this.animationFrame === null) {
      this.animationFrame = requestAnimationFrame(this.syncAlignment);
    }
  };

  private readonly syncAlignment = (): void => {
    this.animationFrame = null;
    if (!this.stage || !this.layer) {
      return;
    }
    const slot = this.stage.querySelector<HTMLElement>(
      `[data-carousel-placeholder], .${styles.emptyHeroCarouselPlaceholder}`
    );
    if (!slot) {
      this.layer.style.removeProperty("--agent-gui-hero-carousel-slot-top");
      return;
    }
    const top =
      slot.getBoundingClientRect().top - this.stage.getBoundingClientRect().top;
    this.layer.style.setProperty(
      "--agent-gui-hero-carousel-slot-top",
      `${top}px`
    );
  };

  private readonly setLayer = (element: HTMLDivElement | null): void => {
    this.layer = element;
  };

  private readonly setStage = (element: HTMLDivElement | null): void => {
    this.stage = element;
  };
}
