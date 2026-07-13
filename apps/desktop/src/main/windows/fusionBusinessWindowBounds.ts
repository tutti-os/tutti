import type {
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "../../shared/contracts/fusion.ts";

export interface FusionBusinessWindowBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface FusionBusinessWindowSize {
  height: number;
  width: number;
}

export interface FusionBusinessWindowDisplay {
  id: number;
  workArea: FusionBusinessWindowBounds;
}

export interface FusionBusinessWindowIdentity {
  kind: DesktopFusionWindowKind;
  resourceId?: string | null;
  workspaceId: string;
}

export interface PersistedFusionBusinessWindowBounds extends FusionBusinessWindowBounds {
  displayId: number;
  updatedAtUnixMs: number;
}

export interface PersistedFusionBusinessWindowBoundsState {
  entries: Record<string, PersistedFusionBusinessWindowBounds>;
  version: 1;
}

export interface ResolveFusionBusinessWindowBoundsInput {
  cascade?: boolean;
  cascadeOffset?: number;
  defaultBounds: FusionBusinessWindowBounds;
  displays: readonly FusionBusinessWindowDisplay[];
  occupiedBounds?: readonly FusionBusinessWindowBounds[];
  persisted?: PersistedFusionBusinessWindowBounds | null;
  primaryDisplay: FusionBusinessWindowDisplay;
}

export interface ResolvedFusionBusinessWindowBounds extends FusionBusinessWindowBounds {
  displayId: number;
}

const defaultCascadeOffsetPx = 28;
const maximumCascadeSteps = 24;
const maximumPersistedEntries = 256;

export function createEmptyFusionBusinessWindowBoundsState(): PersistedFusionBusinessWindowBoundsState {
  return { entries: {}, version: 1 };
}

export function createFusionBusinessWindowBoundsKey(
  identity: FusionBusinessWindowIdentity
): string {
  return JSON.stringify([
    identity.workspaceId.trim(),
    identity.kind,
    normalizeOptionalText(identity.resourceId)
  ]);
}

export function readFusionBusinessWindowBounds(
  state: PersistedFusionBusinessWindowBoundsState,
  identity: FusionBusinessWindowIdentity
): PersistedFusionBusinessWindowBounds | null {
  const exact = state.entries[createFusionBusinessWindowBoundsKey(identity)];
  if (exact) {
    return exact;
  }
  if (normalizeOptionalText(identity.resourceId) === null) {
    return null;
  }
  return (
    state.entries[
      createFusionBusinessWindowBoundsKey({ ...identity, resourceId: null })
    ] ?? null
  );
}

export function writeFusionBusinessWindowBounds(
  state: PersistedFusionBusinessWindowBoundsState,
  identity: FusionBusinessWindowIdentity,
  bounds: PersistedFusionBusinessWindowBounds
): PersistedFusionBusinessWindowBoundsState {
  const key = createFusionBusinessWindowBoundsKey(identity);
  const entries = { ...state.entries, [key]: bounds };
  const sortedEntries = Object.entries(entries).sort(
    ([leftKey, left], [rightKey, right]) =>
      right.updatedAtUnixMs - left.updatedAtUnixMs ||
      leftKey.localeCompare(rightKey)
  );
  return {
    entries: Object.fromEntries(
      sortedEntries.slice(0, maximumPersistedEntries)
    ),
    version: 1
  };
}

export function isPersistedFusionBusinessWindowBoundsState(
  value: unknown
): value is PersistedFusionBusinessWindowBoundsState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedFusionBusinessWindowBoundsState>;
  if (
    candidate.version !== 1 ||
    !candidate.entries ||
    typeof candidate.entries !== "object" ||
    Array.isArray(candidate.entries)
  ) {
    return false;
  }
  return Object.values(candidate.entries).every(
    isPersistedFusionBusinessWindowBounds
  );
}

export function resolveFusionBusinessWindowBounds({
  cascade = false,
  cascadeOffset = defaultCascadeOffsetPx,
  defaultBounds,
  displays,
  occupiedBounds = [],
  persisted,
  primaryDisplay
}: ResolveFusionBusinessWindowBoundsInput): ResolvedFusionBusinessWindowBounds {
  const display = resolveTargetDisplay(
    displays,
    persisted ?? defaultBounds,
    persisted?.displayId,
    primaryDisplay
  );
  const width = clampSize(
    persisted?.width ?? defaultBounds.width,
    display.workArea.width
  );
  const height = clampSize(
    persisted?.height ?? defaultBounds.height,
    display.workArea.height
  );
  const baseBounds = clampBoundsToWorkArea(
    {
      height,
      width,
      x: persisted?.x ?? defaultBounds.x,
      y: persisted?.y ?? defaultBounds.y
    },
    display.workArea
  );
  const bounds = cascade
    ? cascadeBusinessWindowBounds(
        baseBounds,
        display.workArea,
        occupiedBounds,
        cascadeOffset
      )
    : baseBounds;
  return { ...bounds, displayId: display.id };
}

export function resolveFusionBusinessWindowMinimumSize(input: {
  configured: FusionBusinessWindowSize;
  workArea: FusionBusinessWindowSize;
}): FusionBusinessWindowSize {
  return {
    height: clampSize(input.configured.height, input.workArea.height),
    width: clampSize(input.configured.width, input.workArea.width)
  };
}

export function toFusionBusinessWindowIdentity(
  descriptor: Pick<
    DesktopFusionWindowDescriptor,
    "kind" | "resourceId" | "workspaceId"
  >
): FusionBusinessWindowIdentity {
  return {
    kind: descriptor.kind,
    resourceId: descriptor.resourceId,
    workspaceId: descriptor.workspaceId
  };
}

function isPersistedFusionBusinessWindowBounds(
  value: unknown
): value is PersistedFusionBusinessWindowBounds {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersistedFusionBusinessWindowBounds>;
  return (
    Number.isFinite(candidate.displayId) &&
    Number.isFinite(candidate.height) &&
    Number.isFinite(candidate.updatedAtUnixMs) &&
    Number.isFinite(candidate.width) &&
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number(candidate.height) > 0 &&
    Number(candidate.width) > 0
  );
}

function resolveTargetDisplay(
  displays: readonly FusionBusinessWindowDisplay[],
  candidateBounds: FusionBusinessWindowBounds,
  preferredDisplayId: number | undefined,
  primaryDisplay: FusionBusinessWindowDisplay
): FusionBusinessWindowDisplay {
  const preferred = displays.find(
    (display) => display.id === preferredDisplayId
  );
  if (preferred) {
    return preferred;
  }
  const intersecting = [...displays].sort(
    (left, right) =>
      intersectionArea(right.workArea, candidateBounds) -
      intersectionArea(left.workArea, candidateBounds)
  )[0];
  return intersecting &&
    intersectionArea(intersecting.workArea, candidateBounds) > 0
    ? intersecting
    : primaryDisplay;
}

function cascadeBusinessWindowBounds(
  bounds: FusionBusinessWindowBounds,
  workArea: FusionBusinessWindowBounds,
  occupiedBounds: readonly FusionBusinessWindowBounds[],
  cascadeOffset: number
): FusionBusinessWindowBounds {
  if (!isOriginOccupied(bounds, occupiedBounds)) {
    return bounds;
  }
  const offset = Math.max(1, Math.round(cascadeOffset));
  const maximumX = workArea.x + Math.max(0, workArea.width - bounds.width);
  const maximumY = workArea.y + Math.max(0, workArea.height - bounds.height);
  const xDirection =
    maximumX - bounds.x >= offset
      ? 1
      : bounds.x - workArea.x >= offset
        ? -1
        : 0;
  const yDirection =
    maximumY - bounds.y >= offset
      ? 1
      : bounds.y - workArea.y >= offset
        ? -1
        : 0;

  for (const direction of [1, -1]) {
    for (let step = 1; step <= maximumCascadeSteps; step += 1) {
      const candidate = clampBoundsToWorkArea(
        {
          ...bounds,
          x: bounds.x + xDirection * direction * offset * step,
          y: bounds.y + yDirection * direction * offset * step
        },
        workArea
      );
      if (
        (candidate.x !== bounds.x || candidate.y !== bounds.y) &&
        !isOriginOccupied(candidate, occupiedBounds)
      ) {
        return candidate;
      }
    }
  }
  return bounds;
}

function isOriginOccupied(
  candidate: FusionBusinessWindowBounds,
  occupiedBounds: readonly FusionBusinessWindowBounds[]
): boolean {
  return occupiedBounds.some(
    (occupied) => occupied.x === candidate.x && occupied.y === candidate.y
  );
}

function clampBoundsToWorkArea(
  bounds: FusionBusinessWindowBounds,
  workArea: FusionBusinessWindowBounds
): FusionBusinessWindowBounds {
  const width = clampSize(bounds.width, workArea.width);
  const height = clampSize(bounds.height, workArea.height);
  return {
    height,
    width,
    x: clampAxis(bounds.x, workArea.x, workArea.width, width),
    y: clampAxis(bounds.y, workArea.y, workArea.height, height)
  };
}

function clampSize(value: number, maximum: number): number {
  return Math.min(Math.max(1, Math.round(value)), Math.max(1, maximum));
}

function clampAxis(
  value: number,
  workAreaStart: number,
  workAreaSize: number,
  windowSize: number
): number {
  const maximum = workAreaStart + Math.max(0, workAreaSize - windowSize);
  return Math.round(Math.min(maximum, Math.max(workAreaStart, value)));
}

function intersectionArea(
  left: FusionBusinessWindowBounds,
  right: FusionBusinessWindowBounds
): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x)
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y)
  );
  return width * height;
}

function normalizeOptionalText(
  value: string | null | undefined
): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
