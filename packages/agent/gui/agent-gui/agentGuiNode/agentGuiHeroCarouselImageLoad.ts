import claudeVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/claude-vinyl.png";
import codexVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/codex-vinyl.png";
import cursorVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/cursor-vinyl.png";
import hermesVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/hermes-vinyl.png";
import openclawVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/openclaw-vinyl.png";
import opencodeVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/opencode-vinyl.png";
import tuttiVinylAssetUrl from "../../app/renderer/assets/icons/agent-vinyls/tutti-vinyl.png";
import type { AgentGUIAgentAvatarPresentation } from "./model/agentGuiAgentAvatarPresentation";

const AGENT_VINYL_COVER_BY_PROVIDER: Readonly<Record<string, string>> = {
  "claude-code": claudeVinylAssetUrl,
  codex: codexVinylAssetUrl,
  cursor: cursorVinylAssetUrl,
  hermes: hermesVinylAssetUrl,
  openclaw: openclawVinylAssetUrl,
  opencode: opencodeVinylAssetUrl,
  "tutti-agent": tuttiVinylAssetUrl
};

export interface AgentGuiHeroCarouselDecodedImages {
  badges: readonly (HTMLImageElement | null)[];
  covers: readonly (HTMLImageElement | null)[];
  icons: readonly (HTMLImageElement | null)[];
}

interface PendingImageLoad {
  cancel(): void;
  promise: Promise<HTMLImageElement | null>;
}

export class AgentGuiHeroCarouselImageLoad {
  readonly result: Promise<AgentGuiHeroCarouselDecodedImages>;
  private readonly pendingLoads = new Set<PendingImageLoad>();
  private canceled = false;

  constructor(items: readonly AgentGUIAgentAvatarPresentation[]) {
    this.result = Promise.all(
      items.map(async (item) => {
        const [icon, cover, badge] = await Promise.all([
          this.loadImage(item.iconUrl, false),
          this.loadImage(
            item.heroImageUrl?.trim() ||
              AGENT_VINYL_COVER_BY_PROVIDER[item.provider] ||
              null,
            false
          ),
          this.loadImage(item.badge?.iconUrl ?? null, true)
        ]);
        return { badge, cover, icon };
      })
    ).then((entries) => ({
      badges: entries.map((entry) => entry.badge),
      covers: entries.map((entry) => entry.cover),
      icons: entries.map((entry) => entry.icon)
    }));
  }

  cancel(): void {
    if (this.canceled) {
      return;
    }
    this.canceled = true;
    for (const pending of this.pendingLoads) {
      pending.cancel();
    }
    this.pendingLoads.clear();
  }

  private loadImage(
    url: string | null,
    anonymous: boolean
  ): Promise<HTMLImageElement | null> {
    if (!url || this.canceled || typeof Image !== "function") {
      return Promise.resolve(null);
    }
    const image = new Image();
    if (anonymous) {
      image.crossOrigin = "anonymous";
    }
    image.decoding = "async";
    image.loading = "eager";
    image.setAttribute("fetchpriority", "high");
    let settled = false;
    let resolvePromise = (_value: HTMLImageElement | null): void => undefined;
    const pending: PendingImageLoad = {
      cancel: () => settle(null, true),
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
      })
    };
    const settle = (
      value: HTMLImageElement | null,
      clearSource = false
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      image.onload = null;
      image.onerror = null;
      this.pendingLoads.delete(pending);
      if (clearSource) {
        image.src = "";
      }
      resolvePromise(value);
    };
    const settleDecoded = (): void => {
      let decode: Promise<void> | undefined;
      try {
        decode = image.decode?.();
      } catch {
        settle(image);
        return;
      }
      if (decode) {
        void decode.then(() => settle(image)).catch(() => settle(image));
        return;
      }
      settle(image);
    };
    image.onload = settleDecoded;
    image.onerror = () => settle(null);
    this.pendingLoads.add(pending);
    image.src = url;
    if (image.complete) {
      if (image.naturalWidth > 0) {
        settleDecoded();
      } else {
        settle(null);
      }
    }
    return pending.promise;
  }
}
