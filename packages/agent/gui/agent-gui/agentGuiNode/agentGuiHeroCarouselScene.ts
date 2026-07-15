import * as THREE from "three";
import type { AgentGUIAgentAvatarPresentation } from "./model/agentGuiAgentAvatarPresentation";
import {
  coverImageTexture,
  roundedIconTexture,
  vinylRecordTexture
} from "./agentGuiHeroCarouselTextures";

// Three.js scene behind the empty-hero agent carousel, modelled after
// animos.app's "Wheel Carousel": same-sized vinyl records ride the rim of a
// giant wheel whose hub sits far below the stage. The focused agent stands
// upright at the top of the wheel; neighbours tilt tangentially and sink down
// the sides, and the wheel ticks forward with a springy overshoot. The wheel
// is a closed loop, so the carousel wraps seamlessly with no teleports.

const CAMERA_FOV_DEG = 14;
const CAMERA_Z = 7.5;
// The wheel aims for about this many slots around its full rim; the icon
// sequence repeats as often as needed to get close, which also fixes the
// slot angle (2*PI / slots). A broad virtual wheel keeps the visible records
// on a shallow arc instead of exposing an obvious circular silhouette.
const WHEEL_TARGET_SLOTS = 40;
// Center-to-center distance between neighbouring tiles along the rim; tiles
// are 1 unit wide, so the remainder is the visible gap. The wheel radius is
// derived from this, so wider spacing also grows the wheel itself.
const TILE_SPACING = 1.85;
// Compress the visible portion of the wheel into a shallow arc. Horizontal
// spacing still follows the circular loop, while vertical drop and tangent
// tilt are reduced so the records read as a row rather than a ring.
const VISIBLE_ARC_CURVATURE = 0.9;
// Side fade-out is a CSS gradient mask on the canvas element (see
// agentactivity.css): tiles dissolve spatially as they approach the stage
// edges instead of fading per-tile by angle.
// Opacity fades continuously with distance from the focused slot. The CSS mask
// still softens the physical canvas edges, while this range fade makes every
// record step down progressively as it moves away from the center.
const MIN_RECORD_OPACITY = 0.22;
const RECORD_FADE_RANGE_SLOTS = 4.5;
const RECORD_FADE_CURVE = 1.45;
// Records past the immediate neighbours dissolve to fully transparent so no
// half-faded sliver lingers at the stage edges. The kill band begins beyond
// the adjacent records and reaches zero just after two slots.
const RECORD_EDGE_KILL_START_SLOTS = 1.2;
const RECORD_EDGE_KILL_END_SLOTS = 2.05;
// Keep the wheel tactile while giving each click or gesture a more deliberate
// settle. A near-critical spring preserves a hint of physical follow-through
// without the loose overshoot of the previous setting.
const SPRING_STIFFNESS = 120;
const SPRING_DAMPING_RATIO = 0.92;
const SPRING_MIN_LAUNCH_VELOCITY = 2.6;
const SPRING_SETTLE_EPSILON = 0.001;
const SPRING_SETTLE_VELOCITY = 0.02;
const MAX_FRAME_DELTA_SECONDS = 0.032;
const BADGE_CORNER_RADIUS = 0.5;
const BADGE_DIAMETER = 0.36;
const BADGE_OFFSET = 0.4;
const MAX_PIXEL_RATIO = 2;
const RECORD_SPIN_SECONDS = 10;
const RECORD_MODEL_SCALE = 1.3;
const RECORD_MODEL_RADIUS = 0.45;
const RECORD_MODEL_THICKNESS = 0.03;
const RECORD_MODEL_TILT_X = -0.11;
const RECORD_MODEL_SIDE_TILT_FACTOR = 0.18;
const RECORD_MODEL_MAX_SIDE_TILT = 0.16;
const RECORD_RENDER_RANGE_SLOTS = 3.4;
const RECORD_EDGE_SEGMENTS = 48;

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

interface AgentGuiHeroCarouselTile {
  badgeMesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  edgeMaterial: THREE.MeshStandardMaterial;
  edgeMesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  coverTexture: THREE.Texture | null;
  faceMaterial: THREE.MeshBasicMaterial;
  faceMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  poseGroup: THREE.Group;
  ready: boolean;
  recordGroup: THREE.Group;
  rotation: number;
  vinylTexture: THREE.Texture | null;
}

export interface AgentGuiHeroCarouselSceneOptions {
  canvas: HTMLCanvasElement;
  items: readonly AgentGUIAgentAvatarPresentation[];
  loadedBadgeImages: readonly (HTMLImageElement | null)[];
  loadedImages: readonly (HTMLImageElement | null)[];
  loadedCoverImages: readonly (HTMLImageElement | null)[];
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
  private readonly edgeGeometry: THREE.CylinderGeometry;
  private readonly faceGeometry: THREE.PlaneGeometry;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tiles: AgentGuiHeroCarouselTile[] = [];
  private readonly textures = new Set<THREE.Texture>();
  // Number of distinct agents; the wheel holds agentCount * repeats tiles
  // (the icon sequence repeated), and scroll/target count TILE slots.
  private readonly agentCount: number;
  private readonly tileCount: number;
  private readonly wheelRadius: number;
  private readonly onSettle: (index: number) => void;
  private scroll = 0;
  private target = 0;
  private velocity = 0;
  private renderFrameHandle: number | null = null;
  private springFrameHandle: number | null = null;
  private recordSpinFrameHandle: number | null = null;
  private lastFrameAt: number | null = null;
  private lastRecordSpinFrameAt: number | null = null;
  private hoveredTile: AgentGuiHeroCarouselTile | null = null;
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

    // The label artwork remains color-stable on an unlit face plane. These
    // lights shape the thin cylinder underneath so its rim and side wall react
    // like a real pressed record as it moves around the wheel.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.25));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(-2.5, 3.5, 5);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x9fb7ff, 0.9);
    rimLight.position.set(4, -1.5, 2.5);
    this.scene.add(rimLight);

    // Every repeated record has the same shape. Share the GPU vertex buffers
    // and keep the edge tessellation above the pixel density visible here.
    this.faceGeometry = new THREE.PlaneGeometry(1, 1);
    this.edgeGeometry = new THREE.CylinderGeometry(
      RECORD_MODEL_RADIUS,
      RECORD_MODEL_RADIUS,
      RECORD_MODEL_THICKNESS,
      RECORD_EDGE_SEGMENTS,
      1,
      true
    );

    // The icon sequence repeats around the wheel; every copy of an agent's
    // record shares one face texture but keeps its own materials (per-record
    // fade). A shallow cylinder supplies actual thickness beneath the face.
    for (let slot = 0; slot < this.tileCount; slot++) {
      const agentIndex = slot % this.agentCount;
      const poseGroup = new THREE.Group();
      const recordGroup = new THREE.Group();
      recordGroup.scale.setScalar(RECORD_MODEL_SCALE);
      const faceMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        visible: false
      });
      const faceMesh = new THREE.Mesh(this.faceGeometry, faceMaterial);
      faceMesh.position.z = RECORD_MODEL_THICKNESS / 2 + 0.002;
      faceMesh.userData.agentIndex = agentIndex;

      const edgeMaterial = new THREE.MeshStandardMaterial({
        color: 0x070708,
        metalness: 0.42,
        roughness: 0.28,
        transparent: true,
        depthWrite: false
      });
      const edgeMesh = new THREE.Mesh(this.edgeGeometry, edgeMaterial);
      edgeMesh.rotation.x = Math.PI / 2;

      const badgeMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        // The solid circle is the owner marker's asset-independent fallback.
        // Keep it visible while the optional remote avatar is loading or when
        // that avatar cannot safely become a WebGL texture.
        visible: options.items[slot % this.agentCount]?.badge != null
      });
      const badgeMesh = new THREE.Mesh(
        new THREE.CircleGeometry(BADGE_DIAMETER / 2, 32),
        badgeMaterial
      );
      badgeMesh.position.set(
        BADGE_OFFSET,
        -BADGE_OFFSET,
        RECORD_MODEL_THICKNESS / 2 + 0.01
      );
      badgeMesh.userData.agentIndex = agentIndex;

      recordGroup.add(edgeMesh, faceMesh);
      poseGroup.add(recordGroup, badgeMesh);
      poseGroup.visible = false;
      poseGroup.userData.agentIndex = agentIndex;
      this.scene.add(poseGroup);
      this.tiles.push({
        badgeMesh,
        edgeMaterial,
        edgeMesh,
        coverTexture: null,
        faceMaterial,
        faceMesh,
        poseGroup,
        ready: false,
        recordGroup,
        rotation: 0,
        vinylTexture: null
      });
    }
    options.items.forEach((item, agentIndex) => {
      const image = options.loadedImages[agentIndex] ?? null;
      if (image) {
        this.applyImageTexture(image, agentIndex);
      }
      const coverImage = options.loadedCoverImages[agentIndex] ?? null;
      if (coverImage) {
        this.applyCoverImageTexture(coverImage, agentIndex);
      }
      const badgeImage = options.loadedBadgeImages[agentIndex] ?? null;
      if (item.badge?.iconUrl && badgeImage) {
        this.applyBadgeImageTexture(badgeImage, agentIndex);
      }
    });

    this.applyPoses();
    this.startRecordSpin();
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
    // setSize clears the drawing buffer. Render synchronously so a window
    // resize never exposes that cleared frame while the next animation frame
    // is pending during interactive window dragging.
    this.renderer.render(this.scene, this.camera);
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
    this.primeSpringMotion();
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
      this.primeSpringMotion();
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
    const tile = this.pickTile(x, y, width, height);
    const index = tile?.poseGroup.userData.agentIndex;
    return typeof index === "number" ? index : null;
  }

  // Gives playback to the record beneath the pointer. When no record is
  // hovered, playback returns to the record nearest the center.
  hover(x: number, y: number, width: number, height: number): number | null {
    const tile = this.pickTile(x, y, width, height);
    if (tile !== this.hoveredTile) {
      this.hoveredTile = tile;
      this.startRecordSpin();
    }
    const index = tile?.poseGroup.userData.agentIndex;
    return typeof index === "number" ? index : null;
  }

  clearHover(): void {
    this.hoveredTile = null;
    this.startRecordSpin();
  }

  private pickTile(
    x: number,
    y: number,
    width: number,
    height: number
  ): AgentGuiHeroCarouselTile | null {
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
          tile.poseGroup.visible &&
          tile.faceMaterial.visible &&
          tile.faceMaterial.opacity > 0.05
      )
      .flatMap((tile) =>
        tile.badgeMesh.material.visible
          ? [tile.faceMesh, tile.badgeMesh]
          : [tile.faceMesh]
      );
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) {
      return null;
    }
    return (
      this.tiles.find(
        (tile) => tile.faceMesh === hit.object || tile.badgeMesh === hit.object
      ) ?? null
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.renderFrameHandle !== null) {
      cancelAnimationFrame(this.renderFrameHandle);
      this.renderFrameHandle = null;
    }
    if (this.springFrameHandle !== null) {
      cancelAnimationFrame(this.springFrameHandle);
      this.springFrameHandle = null;
    }
    if (this.recordSpinFrameHandle !== null) {
      cancelAnimationFrame(this.recordSpinFrameHandle);
      this.recordSpinFrameHandle = null;
    }
    for (const tile of this.tiles) {
      tile.badgeMesh.geometry.dispose();
      tile.badgeMesh.material.dispose();
      tile.faceMaterial.dispose();
      tile.edgeMaterial.dispose();
    }
    for (const texture of this.textures) {
      texture.dispose();
    }
    this.textures.clear();
    this.faceGeometry.dispose();
    this.edgeGeometry.dispose();
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
    if (this.springFrameHandle === null) {
      // A one-shot resize/texture render must never masquerade as an active
      // spring. Cancel it and let the interaction frame render immediately.
      if (this.renderFrameHandle !== null) {
        cancelAnimationFrame(this.renderFrameHandle);
        this.renderFrameHandle = null;
      }
      this.lastFrameAt = null;
      this.springFrameHandle = requestAnimationFrame(this.frame);
    }
  }

  private primeSpringMotion(): void {
    const delta = this.target - this.scroll;
    const direction = Math.sign(delta);
    if (direction === 0) {
      return;
    }
    // Preserve an already-fast motion in the correct direction. Fresh clicks
    // and reversals receive a small impulse so visible movement begins on the
    // first animation frame instead of waiting for the spring to accelerate.
    if (this.velocity * direction < SPRING_MIN_LAUNCH_VELOCITY) {
      this.velocity = direction * SPRING_MIN_LAUNCH_VELOCITY;
    }
  }

  private readonly frame = (now: number): void => {
    this.springFrameHandle = null;
    if (this.disposed) {
      return;
    }
    const dt =
      this.lastFrameAt === null
        ? 1 / 60
        : Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_DELTA_SECONDS);
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
    this.springFrameHandle = requestAnimationFrame(this.frame);
  };

  private startRecordSpin(): void {
    if (
      this.disposed ||
      this.prefersReducedMotion() ||
      this.recordSpinFrameHandle !== null
    ) {
      return;
    }
    this.lastRecordSpinFrameAt = null;
    this.recordSpinFrameHandle = requestAnimationFrame(this.recordSpinFrame);
  }

  private readonly recordSpinFrame = (now: number): void => {
    this.recordSpinFrameHandle = null;
    const spinningTile = this.centerTile();
    if (this.disposed || !spinningTile || this.prefersReducedMotion()) {
      return;
    }
    const dt =
      this.lastRecordSpinFrameAt === null
        ? 1 / 60
        : Math.min(
            (now - this.lastRecordSpinFrameAt) / 1000,
            MAX_FRAME_DELTA_SECONDS
          );
    this.lastRecordSpinFrameAt = now;
    spinningTile.rotation =
      (spinningTile.rotation + (Math.PI * 2 * dt) / RECORD_SPIN_SECONDS) %
      (Math.PI * 2);
    // While the spring is moving it owns the single pose/render pass. The spin
    // loop only advances its scalar angle, avoiding duplicate transforms.
    if (this.springFrameHandle === null) {
      this.applyPoses();
      this.renderer.render(this.scene, this.camera);
    }
    this.recordSpinFrameHandle = requestAnimationFrame(this.recordSpinFrame);
  };

  private centerTile(): AgentGuiHeroCarouselTile | null {
    let centeredTile: AgentGuiHeroCarouselTile | null = null;
    let centeredOffset = Number.POSITIVE_INFINITY;
    this.tiles.forEach((tile, index) => {
      if (!tile.ready) {
        return;
      }
      const offset = Math.abs(ringOffset(index, this.scroll, this.tileCount));
      if (offset < centeredOffset) {
        centeredTile = tile;
        centeredOffset = offset;
      }
    });
    return centeredTile;
  }

  private requestRender(): void {
    if (
      this.disposed ||
      this.renderFrameHandle !== null ||
      this.springFrameHandle !== null
    ) {
      return;
    }
    this.renderFrameHandle = requestAnimationFrame(() => {
      this.renderFrameHandle = null;
      if (!this.disposed) {
        this.renderer.render(this.scene, this.camera);
      }
    });
  }

  private applyImageTexture(image: HTMLImageElement, agentIndex: number): void {
    if (this.disposed) {
      return;
    }
    const vinylTexture = vinylRecordTexture(image, () => this.requestRender());
    this.textures.add(vinylTexture);
    for (const tile of this.tiles) {
      if (tile.poseGroup.userData.agentIndex === agentIndex) {
        tile.faceMaterial.map = vinylTexture;
        tile.faceMaterial.visible = true;
        tile.faceMaterial.needsUpdate = true;
        tile.vinylTexture = vinylTexture;
        tile.ready = true;
      }
    }
    this.applyPoses();
    this.startRecordSpin();
  }

  private applyCoverImageTexture(
    image: HTMLImageElement,
    agentIndex: number
  ): void {
    if (this.disposed) {
      return;
    }
    const texture = coverImageTexture(image, () => this.requestRender());
    this.textures.add(texture);
    for (const tile of this.tiles) {
      if (tile.poseGroup.userData.agentIndex === agentIndex) {
        tile.coverTexture = texture;
      }
    }
    this.applyPoses();
  }

  private applyBadgeImageTexture(
    image: HTMLImageElement,
    agentIndex: number
  ): void {
    if (this.disposed) {
      return;
    }
    let texture: THREE.CanvasTexture | null = null;
    try {
      texture = roundedIconTexture(
        image,
        () => this.requestRender(),
        BADGE_CORNER_RADIUS
      );
      // Force the upload before replacing the fallback material. This makes
      // Canvas/WebGL failures transactional instead of leaving a visible
      // material pointing at a texture that can never upload.
      this.renderer.initTexture(texture);
    } catch {
      texture?.dispose();
      this.requestRender();
      return;
    }
    this.textures.add(texture);
    for (const tile of this.tiles) {
      if (tile.poseGroup.userData.agentIndex === agentIndex) {
        tile.badgeMesh.material.map = texture;
        tile.badgeMesh.material.visible = true;
        tile.badgeMesh.material.needsUpdate = true;
      }
    }
    this.requestRender();
  }

  private applyPoses(): void {
    const step = (Math.PI * 2) / Math.max(this.tileCount, 1);
    this.tiles.forEach((tile, index) => {
      // Angle from the top of the wheel; the focused tile (offset 0) stands
      // upright at 12 o'clock, neighbours ride down the rim.
      const offset = ringOffset(index, this.scroll, this.tileCount);
      const visible =
        tile.ready && Math.abs(offset) <= RECORD_RENDER_RANGE_SLOTS;
      tile.poseGroup.visible = visible;
      if (!visible) {
        return;
      }
      const angle = offset * step;
      const isCenterTile = Math.abs(offset) < 0.5;
      const faceTexture = isCenterTile ? tile.vinylTexture : tile.coverTexture;
      if (tile.faceMaterial.map !== faceTexture) {
        tile.faceMaterial.map = faceTexture;
        tile.faceMaterial.needsUpdate = true;
      }
      const x = this.wheelRadius * Math.sin(angle);
      const y =
        this.wheelRadius * (Math.cos(angle) - 1) * VISIBLE_ARC_CURVATURE;
      tile.poseGroup.position.set(x, y, 0);
      // Tangent to the rim: the tile's top edge keeps pointing away from the
      // wheel's hub.
      // The focused slot is fully opaque and records fade progressively by
      // distance, restoring the wheel's visible center-to-edge range gradient.
      const fadeProgress = THREE.MathUtils.clamp(
        1 - Math.abs(offset) / RECORD_FADE_RANGE_SLOTS,
        0,
        1
      );
      const rangeOpacity = Math.pow(
        THREE.MathUtils.smoothstep(fadeProgress, 0, 1),
        RECORD_FADE_CURVE
      );
      // The tile tangent still follows the wheel. Record playback rotation is
      // independent, so only the currently hovered record advances while all
      // others retain the angle where their previous hover ended.
      tile.poseGroup.rotation.set(
        RECORD_MODEL_TILT_X,
        THREE.MathUtils.clamp(
          -angle * RECORD_MODEL_SIDE_TILT_FACTOR,
          -RECORD_MODEL_MAX_SIDE_TILT,
          RECORD_MODEL_MAX_SIDE_TILT
        ),
        -angle * VISIBLE_ARC_CURVATURE
      );
      tile.recordGroup.rotation.z = isCenterTile ? -tile.rotation : 0;
      const edgeKill =
        1 -
        THREE.MathUtils.smoothstep(
          Math.abs(offset),
          RECORD_EDGE_KILL_START_SLOTS,
          RECORD_EDGE_KILL_END_SLOTS
        );
      const opacity =
        (MIN_RECORD_OPACITY + (1 - MIN_RECORD_OPACITY) * rangeOpacity) *
        edgeKill;
      tile.faceMaterial.opacity = opacity;
      tile.edgeMaterial.opacity = isCenterTile ? opacity : 0;
      tile.badgeMesh.material.opacity = opacity;
    });
  }
}
