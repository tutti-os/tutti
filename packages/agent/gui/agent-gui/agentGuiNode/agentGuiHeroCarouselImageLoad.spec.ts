import { afterEach, describe, expect, it } from "vitest";
import { AgentGuiHeroCarouselImageLoad } from "./agentGuiHeroCarouselImageLoad";

class FakeImage {
  static instances: FakeImage[] = [];
  static autoLoad = true;

  complete = false;
  crossOrigin: string | null = null;
  decoding = "auto";
  loading = "auto";
  naturalWidth = 100;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  private value = "";

  constructor() {
    FakeImage.instances.push(this);
  }

  decode(): Promise<void> {
    return Promise.resolve();
  }

  get src(): string {
    return this.value;
  }

  set src(value: string) {
    this.value = value;
    if (value && FakeImage.autoLoad) {
      this.complete = true;
      this.onload?.();
    }
  }

  setAttribute(): void {}
}

describe("AgentGuiHeroCarouselImageLoad", () => {
  const originalImage = globalThis.Image;

  afterEach(() => {
    globalThis.Image = originalImage;
    FakeImage.instances.length = 0;
    FakeImage.autoLoad = true;
  });

  it("is the single network owner for icon, cover, and anonymous badge decoding", async () => {
    globalThis.Image = FakeImage as unknown as typeof Image;
    const load = new AgentGuiHeroCarouselImageLoad([
      {
        agentTargetId: "local:codex",
        badge: { iconUrl: "https://cdn.example.com/owner.png" },
        iconUrl: "app://codex.png",
        label: "Codex",
        provider: "codex",
        targetId: "local:codex"
      }
    ]);

    const result = await load.result;

    expect(FakeImage.instances).toHaveLength(3);
    expect(FakeImage.instances[2]?.crossOrigin).toBe("anonymous");
    expect(result.icons[0]).toBe(FakeImage.instances[0]);
    expect(result.covers[0]).toBe(FakeImage.instances[1]);
    expect(result.badges[0]).toBe(FakeImage.instances[2]);
  });

  it("cancels every in-flight image and resolves a stale generation empty", async () => {
    globalThis.Image = FakeImage as unknown as typeof Image;
    FakeImage.autoLoad = false;
    const load = new AgentGuiHeroCarouselImageLoad([
      {
        agentTargetId: "local:codex",
        badge: { iconUrl: "https://cdn.example.com/owner.png" },
        iconUrl: "app://codex.png",
        label: "Codex",
        provider: "codex",
        targetId: "local:codex"
      }
    ]);

    load.cancel();
    const result = await load.result;

    expect(FakeImage.instances.every((image) => image.src === "")).toBe(true);
    expect(result).toEqual({ badges: [null], covers: [null], icons: [null] });
  });
});
