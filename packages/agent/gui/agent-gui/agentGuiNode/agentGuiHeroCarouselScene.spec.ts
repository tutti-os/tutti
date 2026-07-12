import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDisposable {
  disposed: boolean;
  dispose(): void;
}

interface FakeMaterial extends FakeDisposable {
  map?: FakeDisposable;
  needsUpdate: boolean;
  opacity: number;
  visible: boolean;
}

interface FakeMesh {
  children: FakeMesh[];
  geometry: FakeDisposable & { kind: "badge" | "icon" };
  material: FakeMaterial;
  userData: { agentIndex?: number };
}

const threeState = vi.hoisted(() => ({
  materials: [] as FakeMaterial[],
  meshes: [] as FakeMesh[],
  raycastObjects: [] as FakeMesh[],
  rendererDisposed: false,
  textures: [] as FakeDisposable[]
}));

vi.mock("three", () => {
  class FakeGeometry implements FakeDisposable {
    disposed = false;
    readonly kind: "badge" | "icon";

    constructor(kind: "badge" | "icon") {
      this.kind = kind;
    }

    dispose(): void {
      this.disposed = true;
    }
  }

  class PlaneGeometry extends FakeGeometry {
    constructor() {
      super("icon");
    }
  }

  class CircleGeometry extends FakeGeometry {
    constructor() {
      super("badge");
    }
  }

  class MeshBasicMaterial implements FakeMaterial {
    disposed = false;
    map?: FakeDisposable;
    needsUpdate = false;
    opacity = 1;
    visible: boolean;

    constructor(input: { visible?: boolean }) {
      this.visible = input.visible ?? true;
      threeState.materials.push(this);
    }

    dispose(): void {
      this.disposed = true;
    }
  }

  class Mesh implements FakeMesh {
    readonly children: FakeMesh[] = [];
    readonly position = { set: vi.fn() };
    readonly rotation = { z: 0 };
    readonly userData: { agentIndex?: number } = {};

    constructor(
      readonly geometry: FakeDisposable & { kind: "badge" | "icon" },
      readonly material: FakeMaterial
    ) {
      threeState.meshes.push(this);
    }

    add(child: FakeMesh): void {
      this.children.push(child);
    }
  }

  class CanvasTexture implements FakeDisposable {
    anisotropy = 0;
    colorSpace = "";
    disposed = false;

    constructor() {
      threeState.textures.push(this);
    }

    dispose(): void {
      this.disposed = true;
    }
  }

  class WebGLRenderer {
    dispose(): void {
      threeState.rendererDisposed = true;
    }

    render(): void {}
    setClearColor(): void {}
    setPixelRatio(): void {}
    setSize(): void {}
  }

  class Scene {
    add(): void {}
  }

  class PerspectiveCamera {
    aspect = 1;
    readonly position = { set: vi.fn() };
    updateProjectionMatrix(): void {}
  }

  class Raycaster {
    intersectObjects(objects: FakeMesh[]): Array<{ object: FakeMesh }> {
      threeState.raycastObjects = objects;
      const badge = objects.find((mesh) => mesh.geometry.kind === "badge");
      return badge ? [{ object: badge }] : [];
    }

    setFromCamera(): void {}
  }

  class Vector2 {}

  return {
    CanvasTexture,
    CircleGeometry,
    MathUtils: {
      clamp: (value: number, min: number, max: number) =>
        Math.min(Math.max(value, min), max)
    },
    Mesh,
    MeshBasicMaterial,
    PerspectiveCamera,
    PlaneGeometry,
    Raycaster,
    Scene,
    SRGBColorSpace: "srgb",
    Vector2,
    WebGLRenderer
  };
});

import { AgentGuiHeroCarouselScene } from "./agentGuiHeroCarouselScene";

class FakeImage {
  complete = false;
  decoding = "auto";
  height = 100;
  loading = "auto";
  naturalWidth = 100;
  onload: (() => void) | null = null;
  width = 100;
  private value = "";

  get src(): string {
    return this.value;
  }

  set src(value: string) {
    this.value = value;
    if (value) {
      this.onload?.();
    }
  }

  setAttribute(): void {}
}

describe("AgentGuiHeroCarouselScene", () => {
  const originalImage = globalThis.Image;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    threeState.materials.length = 0;
    threeState.meshes.length = 0;
    threeState.raycastObjects.length = 0;
    threeState.rendererDisposed = false;
    threeState.textures.length = 0;
    globalThis.Image = FakeImage as unknown as typeof Image;
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    globalThis.cancelAnimationFrame = vi.fn();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        beginPath: vi.fn(),
        clip: vi.fn(),
        drawImage: vi.fn(),
        roundRect: vi.fn()
      } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    globalThis.Image = originalImage;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("loads badge textures, picks badges, mirrors opacity, and disposes resources", () => {
    const loadedImage = {
      complete: true,
      height: 100,
      naturalWidth: 100,
      onload: null,
      width: 100
    } as unknown as HTMLImageElement;
    const scene = AgentGuiHeroCarouselScene.create({
      canvas: document.createElement("canvas"),
      items: [
        {
          targetId: "agent-1",
          agentTargetId: "agent-1",
          provider: "codex",
          label: "Agent 1",
          iconUrl: "app://agent-1.png",
          badge: { iconUrl: "app://owner-1.png", label: "Owner 1" }
        },
        {
          targetId: "agent-2",
          agentTargetId: "agent-2",
          provider: "claude-code",
          label: "Agent 2",
          iconUrl: "app://agent-2.png"
        }
      ],
      loadedImages: [loadedImage, loadedImage],
      onSettle: vi.fn()
    });

    expect(scene).not.toBeNull();
    const badgeMeshes = threeState.meshes.filter(
      (mesh) => mesh.geometry.kind === "badge"
    );
    expect(badgeMeshes.some((mesh) => mesh.material.visible)).toBe(true);
    expect(
      badgeMeshes
        .filter((mesh) => mesh.material.visible)
        .every((mesh) => mesh.material.map)
    ).toBe(true);

    const iconMeshes = threeState.meshes.filter(
      (mesh) => mesh.geometry.kind === "icon"
    );
    expect(iconMeshes[0]?.material.opacity).toBe(1);
    expect(iconMeshes[0]?.children[0]?.material.opacity).toBe(1);
    expect(iconMeshes[1]?.material.opacity).toBe(0.55);
    expect(iconMeshes[1]?.children[0]?.material.opacity).toBe(0.55);

    expect(scene?.pick(50, 50, 100, 100)).toBe(0);
    expect(
      threeState.raycastObjects.some((mesh) => mesh.geometry.kind === "badge")
    ).toBe(true);

    scene?.dispose();
    expect(threeState.rendererDisposed).toBe(true);
    expect(threeState.materials.every((material) => material.disposed)).toBe(
      true
    );
    expect(threeState.textures.every((texture) => texture.disposed)).toBe(true);
  });
});
