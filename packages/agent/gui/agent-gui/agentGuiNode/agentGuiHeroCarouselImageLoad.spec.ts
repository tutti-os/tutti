import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGuiHeroCarouselImageLoad } from "./agentGuiHeroCarouselImageLoad";

class FakeImage {
  static instances: FakeImage[] = [];
  static autoLoad = true;
  static failuresByUrl = new Map<string, number>();

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
      const failuresRemaining = FakeImage.failuresByUrl.get(value) ?? 0;
      if (failuresRemaining > 0) {
        FakeImage.failuresByUrl.set(value, failuresRemaining - 1);
        this.naturalWidth = 0;
        this.onerror?.();
      } else {
        this.onload?.();
      }
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
    FakeImage.failuresByUrl.clear();
    vi.useRealTimers();
  });

  it("loads every canvas-bound image anonymously before decoding", async () => {
    globalThis.Image = FakeImage as unknown as typeof Image;
    const load = new AgentGuiHeroCarouselImageLoad([
      {
        agentTargetId: "local:codex",
        badge: { iconUrl: "https://cdn.example.com/owner.png" },
        iconUrl: "app://codex.png",
        heroImageUrl: "app://codex-hero.jpg",
        label: "Codex",
        provider: "codex",
        targetId: "local:codex"
      }
    ]);

    const result = await load.result;

    expect(FakeImage.instances).toHaveLength(3);
    expect(FakeImage.instances.map((image) => image.crossOrigin)).toEqual([
      "anonymous",
      "anonymous",
      "anonymous"
    ]);
    expect(FakeImage.instances[1]?.src).toBe("app://codex-hero.jpg");
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

  it("retries a transient owner badge failure", async () => {
    vi.useFakeTimers();
    globalThis.Image = FakeImage as unknown as typeof Image;
    const badgeUrl = "https://cdn.example.com/owner.png";
    FakeImage.failuresByUrl.set(badgeUrl, 1);
    const load = new AgentGuiHeroCarouselImageLoad([
      {
        agentTargetId: "local:codex",
        badge: { iconUrl: badgeUrl },
        iconUrl: "app://codex.png",
        label: "Codex",
        provider: "codex",
        targetId: "local:codex"
      }
    ]);

    await vi.advanceTimersByTimeAsync(150);
    const result = await load.result;

    expect(FakeImage.instances).toHaveLength(4);
    expect(FakeImage.instances[2]?.src).toBe("");
    expect(FakeImage.instances[3]?.crossOrigin).toBe("anonymous");
    expect(FakeImage.instances[3]?.src).toBe(badgeUrl);
    expect(result.badges[0]).toBe(FakeImage.instances[3]);
  });
});
