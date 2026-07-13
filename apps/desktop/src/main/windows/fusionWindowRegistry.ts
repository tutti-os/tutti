import {
  type DesktopFusionOpenWindowInput,
  type DesktopFusionUpdateWindowInput,
  type DesktopFusionWindowDescriptor,
  type DesktopFusionWindowVisibility
} from "../../shared/contracts/fusion.ts";

export interface FusionWindowRegistryDependencies {
  createID(): string;
  now(): number;
}

export class FusionWindowRegistry {
  readonly #dependencies: FusionWindowRegistryDependencies;
  readonly #windows = new Map<string, DesktopFusionWindowDescriptor>();

  constructor(dependencies: FusionWindowRegistryDependencies) {
    this.#dependencies = dependencies;
  }

  create(input: DesktopFusionOpenWindowInput): DesktopFusionWindowDescriptor {
    const createdAtUnixMs = this.#dependencies.now();
    const descriptor: DesktopFusionWindowDescriptor = {
      createdAtUnixMs,
      focused: false,
      kind: input.kind,
      lastFocusedAtUnixMs: 0,
      resourceId: normalizeOptionalText(input.resourceId),
      title: normalizeOptionalText(input.title),
      visibility: "hidden",
      windowInstanceId: this.#dependencies.createID(),
      workspaceId: input.workspaceId.trim()
    };
    this.#windows.set(descriptor.windowInstanceId, descriptor);
    return descriptor;
  }

  find(windowInstanceId: string): DesktopFusionWindowDescriptor | null {
    return this.#windows.get(windowInstanceId) ?? null;
  }

  findReusable(
    input: DesktopFusionOpenWindowInput
  ): DesktopFusionWindowDescriptor | null {
    if (input.forceNew === true) {
      return null;
    }

    const workspaceId = input.workspaceId.trim();
    const resourceId = normalizeOptionalText(input.resourceId);
    return (
      [...this.#windows.values()]
        .filter(
          (descriptor) =>
            descriptor.workspaceId === workspaceId &&
            descriptor.kind === input.kind &&
            (resourceId === null || descriptor.resourceId === resourceId)
        )
        .sort(compareMostRecentlyUsed)[0] ?? null
    );
  }

  list(): DesktopFusionWindowDescriptor[] {
    return [...this.#windows.values()].sort(compareMostRecentlyUsed);
  }

  listForWorkspace(workspaceId: string): DesktopFusionWindowDescriptor[] {
    const normalizedWorkspaceId = workspaceId.trim();
    return this.list().filter(
      (descriptor) => descriptor.workspaceId === normalizedWorkspaceId
    );
  }

  markFocused(windowInstanceId: string): DesktopFusionWindowDescriptor | null {
    const descriptor = this.#windows.get(windowInstanceId);
    if (!descriptor) {
      return null;
    }

    const now = this.#dependencies.now();
    for (const [id, candidate] of this.#windows) {
      const focused = id === windowInstanceId;
      if (
        candidate.focused === focused &&
        (!focused || candidate.visibility === "visible")
      ) {
        continue;
      }
      this.#windows.set(id, {
        ...candidate,
        focused,
        ...(focused
          ? { lastFocusedAtUnixMs: now, visibility: "visible" as const }
          : {})
      });
    }
    return this.#windows.get(windowInstanceId) ?? null;
  }

  markUnfocused(
    windowInstanceId: string
  ): DesktopFusionWindowDescriptor | null {
    return this.#replace(windowInstanceId, (descriptor) => ({
      ...descriptor,
      focused: false
    }));
  }

  setVisibility(
    windowInstanceId: string,
    visibility: DesktopFusionWindowVisibility
  ): DesktopFusionWindowDescriptor | null {
    return this.#replace(windowInstanceId, (descriptor) => ({
      ...descriptor,
      focused: visibility === "visible" ? descriptor.focused : false,
      visibility
    }));
  }

  update(
    input: DesktopFusionUpdateWindowInput
  ): DesktopFusionWindowDescriptor | null {
    return this.#replace(input.windowInstanceId, (descriptor) => ({
      ...descriptor,
      ...(input.resourceId === undefined
        ? {}
        : { resourceId: normalizeOptionalText(input.resourceId) }),
      ...(input.title === undefined
        ? {}
        : { title: normalizeOptionalText(input.title) })
    }));
  }

  remove(windowInstanceId: string): DesktopFusionWindowDescriptor | null {
    const descriptor = this.#windows.get(windowInstanceId) ?? null;
    this.#windows.delete(windowInstanceId);
    return descriptor;
  }

  clear(): void {
    this.#windows.clear();
  }

  #replace(
    windowInstanceId: string,
    update: (
      descriptor: DesktopFusionWindowDescriptor
    ) => DesktopFusionWindowDescriptor
  ): DesktopFusionWindowDescriptor | null {
    const descriptor = this.#windows.get(windowInstanceId);
    if (!descriptor) {
      return null;
    }
    const next = update(descriptor);
    this.#windows.set(windowInstanceId, next);
    return next;
  }
}

function normalizeOptionalText(
  value: string | null | undefined
): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compareMostRecentlyUsed(
  left: DesktopFusionWindowDescriptor,
  right: DesktopFusionWindowDescriptor
): number {
  return (
    right.lastFocusedAtUnixMs - left.lastFocusedAtUnixMs ||
    right.createdAtUnixMs - left.createdAtUnixMs ||
    right.windowInstanceId.localeCompare(left.windowInstanceId)
  );
}
