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
  geometry: FakeDisposable & { kind: "badge" | "edge" | "icon" };
  material: FakeMaterial;
  position: { set: ReturnType<typeof vi.fn>; z: number };
  rotation: { set: ReturnType<typeof vi.fn>; x: number; z: number };
  userData: { agentIndex?: number };
}

const threeState = vi.hoisted(() => ({
  failTextureUpload: false,
  materials: [] as FakeMaterial[],
  meshes: [] as FakeMesh[],
  raycastObjects: [] as FakeMesh[],
  renderCount: 0,
  rendererDisposed: false,
  textures: [] as FakeDisposable[]
}));

vi.mock("three", () => {
  class FakeGeometry implements FakeDisposable {
    disposed = false;
    readonly kind: "badge" | "edge" | "icon";

    constructor(kind: "badge" | "edge" | "icon") {
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

  class CylinderGeometry extends FakeGeometry {
    constructor() {
      super("edge");
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

  class MeshStandardMaterial extends MeshBasicMaterial {}

  class Group {
    readonly children: FakeMesh[] = [];
    readonly position = { set: vi.fn(), z: 0 };
    readonly rotation = { set: vi.fn(), x: 0, z: 0 };
    readonly scale = { setScalar: vi.fn() };
    readonly userData: { agentIndex?: number } = {};
    visible = true;

    add(...children: FakeMesh[]): void {
      this.children.push(...children);
    }
  }

  class Mesh extends Group implements FakeMesh {
    constructor(
      readonly geometry: FakeDisposable & {
        kind: "badge" | "edge" | "icon";
      },
      readonly material: FakeMaterial
    ) {
      super();
      threeState.meshes.push(this);
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

    initTexture(): void {
      if (threeState.failTextureUpload) {
        throw new Error("texture upload failed");
      }
    }

    render(): void {
      threeState.renderCount += 1;
    }
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

  class AmbientLight {}

  class DirectionalLight {
    readonly position = { set: vi.fn() };
  }

  return {
    AmbientLight,
    CanvasTexture,
    CircleGeometry,
    CylinderGeometry,
    DirectionalLight,
    Group,
    MathUtils: {
      clamp: (value: number, min: number, max: number) =>
        Math.min(Math.max(value, min), max),
      smoothstep: (value: number, min: number, max: number) =>
        Math.min(Math.max((value - min) / (max - min), 0), 1)
    },
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
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
  static instances: FakeImage[] = [];
  static nextDecodeFailure = false;
  static nextLoadFailure = false;

  complete = false;
  crossOrigin: string | null = null;
  decode?: () => Promise<void>;
  decoding = "auto";
  height = 100;
  loading = "auto";
  naturalWidth = 100;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  width = 100;
  private value = "";

  constructor() {
    if (FakeImage.nextDecodeFailure) {
      FakeImage.nextDecodeFailure = false;
      this.decode = () => Promise.reject(new Error("decode failed"));
    }
    FakeImage.instances.push(this);
  }

  get src(): string {
    return this.value;
  }

  set src(value: string) {
    this.value = value;
    if (value) {
      if (FakeImage.nextLoadFailure) {
        FakeImage.nextLoadFailure = false;
        this.onerror?.();
      } else {
        this.onload?.();
      }
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
    threeState.failTextureUpload = false;
    threeState.materials.length = 0;
    threeState.meshes.length = 0;
    threeState.raycastObjects.length = 0;
    threeState.renderCount = 0;
    threeState.rendererDisposed = false;
    threeState.textures.length = 0;
    FakeImage.instances.length = 0;
    FakeImage.nextDecodeFailure = false;
    FakeImage.nextLoadFailure = false;
    globalThis.Image = FakeImage as unknown as typeof Image;
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    globalThis.cancelAnimationFrame = vi.fn();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        arc: vi.fn(),
        beginPath: vi.fn(),
        clearRect: vi.fn(),
        clip: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        drawImage: vi.fn(),
        fill: vi.fn(),
        fillRect: vi.fn(),
        restore: vi.fn(),
        rotate: vi.fn(),
        roundRect: vi.fn(),
        save: vi.fn(),
        stroke: vi.fn(),
        translate: vi.fn()
      } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    globalThis.Image = originalImage;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("uploads decoded badge textures, picks badges, mirrors opacity, and disposes GPU resources", () => {
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
      loadedBadgeImages: [loadedImage, null],
      loadedCoverImages: [null, null],
      loadedImages: [loadedImage, loadedImage],
      onSettle: vi.fn()
    });

    expect(scene).not.toBeNull();
    expect(FakeImage.instances).toHaveLength(0);
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
    const centeredIcon = iconMeshes.find(
      (mesh) => mesh.userData.agentIndex === 0 && mesh.material.opacity === 1
    );
    const centeredBadge = badgeMeshes.find(
      (mesh) => mesh.userData.agentIndex === 0 && mesh.material.visible
    );
    expect(centeredIcon).toBeDefined();
    expect(centeredBadge?.material.opacity).toBe(
      centeredIcon?.material.opacity
    );

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

  it("keeps a visible programmatic badge when the decoded badge is unavailable", () => {
    const requestAnimationFrame = vi.mocked(globalThis.requestAnimationFrame);
    const scene = createSceneWithBadge(null);
    const badgeMaterials = badgeMaterialsForAgent(0);

    expect(FakeImage.instances).toHaveLength(0);
    expect(badgeMaterials.every((material) => material.visible)).toBe(true);
    expect(badgeMaterials.every((material) => material.map == null)).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalled();

    scene?.dispose();
  });

  it("renders immediately after resizing to avoid a cleared frame", () => {
    const scene = createSceneWithBadge(null);

    expect(scene).not.toBeNull();
    expect(threeState.renderCount).toBe(0);

    scene?.setSize(320, 112);

    expect(threeState.renderCount).toBe(1);
    scene?.dispose();
  });

  it("disposes a rejected texture and keeps the fallback when WebGL upload fails", () => {
    threeState.failTextureUpload = true;
    const scene = createSceneWithBadge(createLoadedImage());
    const badgeMaterials = badgeMaterialsForAgent(0);

    expect(badgeMaterials.every((material) => material.visible)).toBe(true);
    expect(badgeMaterials.every((material) => material.map == null)).toBe(true);
    expect(threeState.textures).toHaveLength(2);
    expect(threeState.textures.at(-1)?.disposed).toBe(true);

    scene?.dispose();
  });
});

function createLoadedImage(): HTMLImageElement {
  return {
    complete: true,
    height: 100,
    naturalWidth: 100,
    onload: null,
    width: 100
  } as unknown as HTMLImageElement;
}

function createSceneWithBadge(
  badgeImage: HTMLImageElement | null
): AgentGuiHeroCarouselScene | null {
  const loadedImage = createLoadedImage();
  return AgentGuiHeroCarouselScene.create({
    canvas: document.createElement("canvas"),
    items: [
      {
        targetId: "agent-1",
        agentTargetId: "agent-1",
        provider: "codex",
        label: "Agent 1",
        iconUrl: "app://agent-1.png",
        badge: {
          iconUrl: "https://cdn.example.com/owner-1.png",
          label: "Owner 1"
        }
      }
    ],
    loadedBadgeImages: [badgeImage],
    loadedCoverImages: [null],
    loadedImages: [loadedImage],
    onSettle: vi.fn()
  });
}

function badgeMaterialsForAgent(agentIndex: number): FakeMaterial[] {
  return threeState.meshes
    .filter(
      (mesh) =>
        mesh.geometry.kind === "badge" &&
        mesh.userData.agentIndex === agentIndex
    )
    .map((mesh) => mesh.material);
}
