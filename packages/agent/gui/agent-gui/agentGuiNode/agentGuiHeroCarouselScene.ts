import * as THREE from "three";
import type { AgentGUIAgentAvatarPresentation } from "./model/agentGuiAgentAvatarPresentation";

// Three.js scene behind the empty-hero agent carousel, modelled after
// animos.app's "Wheel Carousel": same-sized flat tiles ride the rim of a
// giant wheel whose hub sits far below the stage. The focused agent stands
// upright at the top of the wheel; neighbours tilt tangentially and sink down
// the sides, and the wheel ticks forward with a springy overshoot. The wheel
// is a closed loop, so the carousel wraps seamlessly with no teleports.

const CAMERA_FOV_DEG = 14;
const CAMERA_Z = 7.5;
// The wheel aims for about this many slots around its full rim; the icon
// sequence repeats as often as needed to get close, which also fixes the
// slot angle (2*PI / slots) and keeps neighbour tilts gentle (~17deg).
const WHEEL_TARGET_SLOTS = 21;
// Center-to-center distance between neighbouring tiles along the rim; tiles
// are 1 unit wide, so the remainder is the visible gap. The wheel radius is
// derived from this, so wider spacing also grows the wheel itself.
const TILE_SPACING = 1.35;
// Side fade-out is a CSS gradient mask on the canvas element (see
// agentactivity.css): tiles dissolve spatially as they approach the stage
// edges instead of fading per-tile by angle.
// On top of that, only the focused tile is fully opaque — every other tile
// rests at this opacity (the transition interpolates while the wheel spins).
const UNFOCUSED_OPACITY = 0.55;
// Underdamped spring for the wheel's "tick": stiffness sets the pace, and a
// damping ratio below 1 gives the anticipation-and-overshoot landing.
const SPRING_STIFFNESS = 90;
const SPRING_DAMPING_RATIO = 0.62;
const SPRING_SETTLE_EPSILON = 0.001;
const SPRING_SETTLE_VELOCITY = 0.02;
const TEXTURE_SIZE = 256;
const TEXTURE_CORNER_RADIUS = 0.05;
const BADGE_CORNER_RADIUS = 0.5;
const BADGE_DIAMETER = 0.36;
const BADGE_OFFSET = 0.4;
const MAX_PIXEL_RATIO = 2;

// Signed ring offset of tile `index` for a continuous scroll position, in
// (-count / 2, count / 2].
function ringOffset(index: number, scroll: number, count: number): number {
  if (count <= 1) {
    return index - scroll;
  }
  let offset = (index - scroll) % count;
  const half = count / 2;
  if (offset > half) {
    offset -= count;
  } else if (offset < -half) {
    offset += count;
  }
  return offset;
}

// Draws the icon into a rounded-rect canvas so square, full-bleed PNGs get
// rounded tiles without custom shaders.
function roundedIconTexture(
  image: HTMLImageElement,
  onReadyRender: () => void,
  cornerRadius = TEXTURE_CORNER_RADIUS
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context) {
    const radius = TEXTURE_SIZE * cornerRadius;
    context.beginPath();
    context.roundRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE, radius);
    context.clip();
    // Cover-fit so non-square icons fill the tile.
    const scale = Math.max(
      TEXTURE_SIZE / image.width,
      TEXTURE_SIZE / image.height
    );
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(
      image,
      (TEXTURE_SIZE - width) / 2,
      (TEXTURE_SIZE - height) / 2,
      width,
      height
    );
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  onReadyRender();
  return texture;
}

interface AgentGuiHeroCarouselTile {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  badgeMesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

export interface AgentGuiHeroCarouselSceneOptions {
  canvas: HTMLCanvasElement;
  items: readonly AgentGUIAgentAvatarPresentation[];
  loadedImages?: readonly (HTMLImageElement | null)[];
  // Fired once the wheel settles on an integer slot after an animated move.
  onSettle: (index: number) => void;
}

export class AgentGuiHeroCarouselScene {
  // Returns null when a WebGL context is unavailable (e.g. jsdom tests); the
  // component keeps its hidden DOM switcher working without visuals.
  static create(
    options: AgentGuiHeroCarouselSceneOptions
  ): AgentGuiHeroCarouselScene | null {
    try {
      return new AgentGuiHeroCarouselScene(options);
    } catch {
      return null;
    }
  }

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tiles: AgentGuiHeroCarouselTile[] = [];
  // Number of distinct agents; the wheel holds agentCount * repeats tiles
  // (the icon sequence repeated), and scroll/target count TILE slots.
  private readonly agentCount: number;
  private readonly tileCount: number;
  private readonly wheelRadius: number;
  private readonly onSettle: (index: number) => void;
  private readonly images: HTMLImageElement[] = [];
  private readonly ownedImages = new Set<HTMLImageElement>();
  private scroll = 0;
  private target = 0;
  private velocity = 0;
  private frameHandle: number | null = null;
  private lastFrameAt: number | null = null;
  private disposed = false;

  private constructor(options: AgentGuiHeroCarouselSceneOptions) {
    this.agentCount = options.items.length;
    const repeats = Math.max(
      1,
      Math.round(WHEEL_TARGET_SLOTS / Math.max(this.agentCount, 1))
    );
    this.tileCount = this.agentCount * repeats;
    // Rim spacing fixes the wheel size: radius = arc spacing / slot angle.
    this.wheelRadius = (TILE_SPACING * this.tileCount) / (Math.PI * 2);
    this.onSettle = options.onSettle;
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      alpha: true,
      antialias: true
    });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 50);
    this.camera.position.set(0, 0, CAMERA_Z);

    // The icon sequence repeats around the wheel; every copy of an agent's
    // tile shares one texture but keeps its own material (per-tile fade).
    for (let slot = 0; slot < this.tileCount; slot++) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        visible: false
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.agentIndex = slot % this.agentCount;
      const badgeMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        visible: false
      });
      const badgeMesh = new THREE.Mesh(
        new THREE.CircleGeometry(BADGE_DIAMETER / 2, 32),
        badgeMaterial
      );
      badgeMesh.position.set(BADGE_OFFSET, -BADGE_OFFSET, 0.01);
      badgeMesh.userData.agentIndex = slot % this.agentCount;
      mesh.add(badgeMesh);
      this.scene.add(mesh);
      this.tiles.push({ badgeMesh, mesh });
    }
    options.items.forEach((item, agentIndex) => {
      const loadedImage = options.loadedImages?.[agentIndex] ?? null;
      const image = loadedImage ?? new Image();
      if (!loadedImage) {
        image.decoding = "async";
        image.loading = "eager";
        image.setAttribute("fetchpriority", "high");
        this.ownedImages.add(image);
      }
      this.images.push(image);
      image.onload = () => {
        if (this.disposed) {
          return;
        }
        this.applyImageTexture(image, agentIndex);
      };
      if (image.complete && image.naturalWidth > 0) {
        this.applyImageTexture(image, agentIndex);
      } else if (!loadedImage) {
        image.src = item.iconUrl;
      }
      if (item.badge?.iconUrl) {
        this.loadBadgeImage(item.badge.iconUrl, agentIndex);
      }
    });

    this.applyPoses();
  }

  setSize(width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) {
      return;
    }
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
    );
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // Agent index of the tile slot the wheel is heading to.
  targetIndex(): number {
    const slot =
      ((Math.round(this.target) % this.tileCount) + this.tileCount) %
      this.tileCount;
    return slot % this.agentCount;
  }

  // Advances the wheel one tile slot (= the next/previous agent, since the
  // icon sequence repeats); returns the normalized agent index.
  stepBy(direction: 1 | -1): number {
    this.target += direction;
    this.animate();
    return this.targetIndex();
  }

  // Spins the wheel to the nearest copy of agent `index`.
  moveTo(index: number, animateMove = true): void {
    const agent =
      ((index % this.agentCount) + this.agentCount) % this.agentCount;
    if (this.targetIndex() === agent) {
      if (!animateMove) {
        this.scroll = this.target;
        this.velocity = 0;
        this.applyPoses();
        this.requestRender();
      }
      return;
    }
    // Among the repeated copies of this agent, pick the shortest spin.
    let best: number | null = null;
    for (let copy = 0; copy * this.agentCount < this.tileCount; copy++) {
      const offset = ringOffset(
        agent + copy * this.agentCount,
        this.target,
        this.tileCount
      );
      if (best === null || Math.abs(offset) < Math.abs(best)) {
        best = offset;
      }
    }
    this.target += best ?? 0;
    if (animateMove) {
      this.animate();
      return;
    }
    this.scroll = this.target;
    this.velocity = 0;
    this.applyPoses();
    this.requestRender();
  }

  // Canvas-relative pointer coordinates -> agent index, or null.
  pick(x: number, y: number, width: number, height: number): number | null {
    if (this.disposed || width <= 0 || height <= 0) {
      return null;
    }
    const pointer = new THREE.Vector2(
      (x / width) * 2 - 1,
      -(y / height) * 2 + 1
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const meshes = this.tiles
      .filter(
        (tile) =>
          tile.mesh.material.visible && tile.mesh.material.opacity > 0.05
      )
      .flatMap((tile) =>
        tile.badgeMesh.material.visible
          ? [tile.mesh, tile.badgeMesh]
          : [tile.mesh]
      );
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const index = hit?.object.userData.agentIndex;
    return typeof index === "number" ? index : null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    for (const image of this.images) {
      image.onload = null;
      if (this.ownedImages.has(image)) {
        image.src = "";
      }
    }
    this.ownedImages.clear();
    for (const tile of this.tiles) {
      tile.mesh.geometry.dispose();
      tile.mesh.material.map?.dispose();
      tile.mesh.material.dispose();
      tile.badgeMesh.geometry.dispose();
      tile.badgeMesh.material.map?.dispose();
      tile.badgeMesh.material.dispose();
    }
    // Do NOT force a context loss here: React StrictMode replays the mount
    // effect on the SAME canvas element, and a forced loss would hand the
    // second scene a dead context (white "sad canvas"). Disposing the
    // renderer releases its GL resources; the context itself is reclaimed
    // with the canvas element.
    this.renderer.dispose();
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private animate(): void {
    if (this.disposed) {
      return;
    }
    if (this.prefersReducedMotion()) {
      this.scroll = this.target;
      this.velocity = 0;
      this.applyPoses();
      this.requestRender();
      this.onSettle(this.targetIndex());
      return;
    }
    if (this.frameHandle === null) {
      this.lastFrameAt = null;
      this.frameHandle = requestAnimationFrame(this.frame);
    }
  }

  private readonly frame = (now: number): void => {
    this.frameHandle = null;
    if (this.disposed) {
      return;
    }
    const dt =
      this.lastFrameAt === null
        ? 1 / 60
        : Math.min((now - this.lastFrameAt) / 1000, 0.05);
    this.lastFrameAt = now;
    const delta = this.target - this.scroll;
    if (
      Math.abs(delta) <= SPRING_SETTLE_EPSILON &&
      Math.abs(this.velocity) <= SPRING_SETTLE_VELOCITY
    ) {
      this.scroll = this.target;
      this.velocity = 0;
      this.applyPoses();
      this.renderer.render(this.scene, this.camera);
      this.onSettle(this.targetIndex());
      return;
    }
    // Underdamped spring: the wheel ticks into place with a slight overshoot.
    const damping = 2 * Math.sqrt(SPRING_STIFFNESS) * SPRING_DAMPING_RATIO;
    this.velocity += (SPRING_STIFFNESS * delta - damping * this.velocity) * dt;
    this.scroll += this.velocity * dt;
    this.applyPoses();
    this.renderer.render(this.scene, this.camera);
    this.frameHandle = requestAnimationFrame(this.frame);
  };

  private requestRender(): void {
    if (this.disposed || this.frameHandle !== null) {
      return;
    }
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      if (!this.disposed) {
        this.renderer.render(this.scene, this.camera);
      }
    });
  }

  private applyImageTexture(image: HTMLImageElement, agentIndex: number): void {
    if (this.disposed) {
      return;
    }
    const texture = roundedIconTexture(image, () => this.requestRender());
    for (const tile of this.tiles) {
      if (tile.mesh.userData.agentIndex === agentIndex) {
        tile.mesh.material.map = texture;
        tile.mesh.material.visible = true;
        tile.mesh.material.needsUpdate = true;
      }
    }
  }

  private loadBadgeImage(badgeUrl: string, agentIndex: number): void {
    const image = new Image();
    image.decoding = "async";
    image.loading = "eager";
    this.ownedImages.add(image);
    this.images.push(image);
    image.onload = () => {
      if (this.disposed) {
        return;
      }
      const texture = roundedIconTexture(
        image,
        () => this.requestRender(),
        BADGE_CORNER_RADIUS
      );
      for (const tile of this.tiles) {
        if (tile.mesh.userData.agentIndex === agentIndex) {
          tile.badgeMesh.material.map = texture;
          tile.badgeMesh.material.visible = true;
          tile.badgeMesh.material.needsUpdate = true;
        }
      }
      this.requestRender();
    };
    image.src = badgeUrl;
  }

  private applyPoses(): void {
    const step = (Math.PI * 2) / Math.max(this.tileCount, 1);
    this.tiles.forEach((tile, index) => {
      // Angle from the top of the wheel; the focused tile (offset 0) stands
      // upright at 12 o'clock, neighbours ride down the rim.
      const offset = ringOffset(index, this.scroll, this.tileCount);
      const angle = offset * step;
      const x = this.wheelRadius * Math.sin(angle);
      const y = this.wheelRadius * (Math.cos(angle) - 1);
      tile.mesh.position.set(x, y, 0);
      // Tangent to the rim: the tile's top edge keeps pointing away from the
      // wheel's hub.
      tile.mesh.rotation.z = -angle;
      // Only the focused slot is fully opaque; a tile brightens as it
      // approaches the top and dims as it leaves.
      const focus = THREE.MathUtils.clamp(1 - Math.abs(offset), 0, 1);
      tile.mesh.material.opacity =
        UNFOCUSED_OPACITY + (1 - UNFOCUSED_OPACITY) * focus;
      tile.badgeMesh.material.opacity = tile.mesh.material.opacity;
    });
  }
}
