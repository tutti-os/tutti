import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";

export interface WorkspaceAppLaunchIntentTarget {
  appID: string;
  ownerWebContentsId: number;
  workspaceID: string;
}

export function shouldResetWorkspaceAppLaunchIntentReadiness(input: {
  isMainFrame: boolean;
  isSameDocument: boolean;
}): boolean {
  return input.isMainFrame && !input.isSameDocument;
}

interface QueuedLaunchIntent {
  enqueuedAtMs: number;
  intent: TuttiExternalWorkspaceOpenRouteIntent;
  ownerWebContentsId: number;
}

const defaultLaunchIntentTtlMs = 5 * 60 * 1000;
const defaultMaxIntentsPerTarget = 32;
const defaultMaxTotalIntents = 512;
const defaultMaxTargets = 128;

export class WorkspaceAppLaunchIntentQueue {
  readonly #entries = new Map<string, QueuedLaunchIntent[]>();
  readonly #maxIntentsPerTarget: number;
  readonly #maxTargets: number;
  readonly #maxTotalIntents: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options?: {
    maxIntentsPerTarget?: number;
    maxTargets?: number;
    maxTotalIntents?: number;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.#maxIntentsPerTarget =
      options?.maxIntentsPerTarget ?? defaultMaxIntentsPerTarget;
    this.#maxTargets = options?.maxTargets ?? defaultMaxTargets;
    this.#maxTotalIntents = options?.maxTotalIntents ?? defaultMaxTotalIntents;
    this.#now = options?.now ?? Date.now;
    this.#ttlMs = options?.ttlMs ?? defaultLaunchIntentTtlMs;
  }

  clearOwner(ownerWebContentsId: number): void {
    for (const [key, entries] of this.#entries) {
      if (entries[0]?.ownerWebContentsId === ownerWebContentsId) {
        this.#entries.delete(key);
      }
    }
  }

  drain(target: WorkspaceAppLaunchIntentTarget) {
    this.#prune();
    const key = launchIntentTargetKey(target);
    const entries = this.#entries.get(key) ?? [];
    this.#entries.delete(key);
    return entries.map((entry) => entry.intent);
  }

  enqueue(
    target: WorkspaceAppLaunchIntentTarget,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): void {
    this.#prune();
    const key = launchIntentTargetKey(target);
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxTargets) {
      this.#evictOldestTarget();
    }
    const entries = this.#entries.get(key) ?? [];
    entries.push({
      enqueuedAtMs: this.#now(),
      intent,
      ownerWebContentsId: target.ownerWebContentsId
    });
    while (entries.length > this.#maxIntentsPerTarget) {
      entries.shift();
    }
    this.#entries.set(key, entries);
    while (this.#totalIntents() > this.#maxTotalIntents) {
      this.#evictOldestIntent();
    }
  }

  prepend(
    target: WorkspaceAppLaunchIntentTarget,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): void {
    this.#prune();
    const key = launchIntentTargetKey(target);
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxTargets) {
      this.#evictOldestTarget();
    }
    const entries = this.#entries.get(key) ?? [];
    entries.unshift({
      enqueuedAtMs: entries[0]?.enqueuedAtMs ?? this.#now(),
      intent,
      ownerWebContentsId: target.ownerWebContentsId
    });
    while (entries.length > this.#maxIntentsPerTarget) {
      entries.pop();
    }
    this.#entries.set(key, entries);
    while (this.#totalIntents() > this.#maxTotalIntents) {
      this.#evictNewestIntent();
    }
  }

  shift(
    target: WorkspaceAppLaunchIntentTarget
  ): TuttiExternalWorkspaceOpenRouteIntent | undefined {
    this.#prune();
    const key = launchIntentTargetKey(target);
    const entries = this.#entries.get(key);
    const intent = entries?.shift()?.intent;
    if (!entries || entries.length === 0) {
      this.#entries.delete(key);
    }
    return intent;
  }

  get size(): number {
    this.#prune();
    return this.#totalIntents();
  }

  #evictOldestIntent(): void {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, entries] of this.#entries) {
      const time = entries[0]?.enqueuedAtMs ?? Number.POSITIVE_INFINITY;
      if (time < oldestTime) {
        oldestKey = key;
        oldestTime = time;
      }
    }
    if (!oldestKey) {
      return;
    }
    const entries = this.#entries.get(oldestKey);
    entries?.shift();
    if (!entries || entries.length === 0) {
      this.#entries.delete(oldestKey);
    }
  }

  #evictOldestTarget(): void {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, entries] of this.#entries) {
      const time = entries[0]?.enqueuedAtMs ?? Number.POSITIVE_INFINITY;
      if (time < oldestTime) {
        oldestKey = key;
        oldestTime = time;
      }
    }
    if (oldestKey) {
      this.#entries.delete(oldestKey);
    }
  }

  #evictNewestIntent(): void {
    let newestKey: string | undefined;
    let newestTime = Number.NEGATIVE_INFINITY;
    for (const [key, entries] of this.#entries) {
      const time = entries.at(-1)?.enqueuedAtMs ?? Number.NEGATIVE_INFINITY;
      if (time > newestTime) {
        newestKey = key;
        newestTime = time;
      }
    }
    if (!newestKey) {
      return;
    }
    const entries = this.#entries.get(newestKey);
    entries?.pop();
    if (!entries || entries.length === 0) {
      this.#entries.delete(newestKey);
    }
  }

  #prune(): void {
    const expiresBefore = this.#now() - this.#ttlMs;
    for (const [key, entries] of this.#entries) {
      while (
        entries[0] !== undefined &&
        entries[0].enqueuedAtMs <= expiresBefore
      ) {
        entries.shift();
      }
      if (entries.length === 0) {
        this.#entries.delete(key);
      }
    }
  }

  #totalIntents(): number {
    let total = 0;
    for (const entries of this.#entries.values()) {
      total += entries.length;
    }
    return total;
  }
}

interface WorkspaceAppLaunchIntentGuest {
  ready: boolean;
  target: WorkspaceAppLaunchIntentTarget;
}

export class WorkspaceAppLaunchIntentDeliveryState {
  readonly #guests = new Map<number, WorkspaceAppLaunchIntentGuest>();
  readonly #queue: WorkspaceAppLaunchIntentQueue;

  constructor(
    options?: ConstructorParameters<typeof WorkspaceAppLaunchIntentQueue>[0]
  ) {
    this.#queue = new WorkspaceAppLaunchIntentQueue(options);
  }

  clearOwner(ownerWebContentsId: number): void {
    this.#queue.clearOwner(ownerWebContentsId);
    for (const [guestWebContentsId, guest] of this.#guests) {
      if (guest.target.ownerWebContentsId === ownerWebContentsId) {
        this.#guests.delete(guestWebContentsId);
      }
    }
  }

  enqueue(
    target: WorkspaceAppLaunchIntentTarget,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): void {
    this.#queue.enqueue(target, intent);
  }

  markNotReady(guestWebContentsId: number): void {
    const guest = this.#guests.get(guestWebContentsId);
    if (guest) {
      guest.ready = false;
    }
  }

  markReady(
    guestWebContentsId: number
  ): TuttiExternalWorkspaceOpenRouteIntent[] {
    const guest = this.#guests.get(guestWebContentsId);
    if (!guest) {
      return [];
    }
    guest.ready = true;
    return this.#queue.drain(guest.target);
  }

  registerGuest(
    guestWebContentsId: number,
    target: WorkspaceAppLaunchIntentTarget
  ): TuttiExternalWorkspaceOpenRouteIntent | undefined {
    this.#guests.set(guestWebContentsId, { ready: false, target });
    return this.#queue.shift(target);
  }

  removeGuest(
    guestWebContentsId: number,
    unconsumedInitial?: TuttiExternalWorkspaceOpenRouteIntent
  ): void {
    const guest = this.#guests.get(guestWebContentsId);
    this.#guests.delete(guestWebContentsId);
    if (guest && unconsumedInitial) {
      this.#queue.prepend(guest.target, unconsumedInitial);
    }
  }

  route(
    target: WorkspaceAppLaunchIntentTarget,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): number[] {
    const readyGuests: number[] = [];
    for (const [guestWebContentsId, guest] of this.#guests) {
      if (guest.ready && targetsEqual(guest.target, target)) {
        readyGuests.push(guestWebContentsId);
      }
    }
    if (readyGuests.length === 0) {
      this.#queue.enqueue(target, intent);
    }
    return readyGuests;
  }

  get queuedIntentCount(): number {
    return this.#queue.size;
  }
}

function launchIntentTargetKey(target: WorkspaceAppLaunchIntentTarget): string {
  return [
    String(target.ownerWebContentsId),
    encodeURIComponent(target.workspaceID),
    encodeURIComponent(target.appID)
  ].join(":");
}

function targetsEqual(
  left: WorkspaceAppLaunchIntentTarget,
  right: WorkspaceAppLaunchIntentTarget
): boolean {
  return (
    left.appID === right.appID &&
    left.ownerWebContentsId === right.ownerWebContentsId &&
    left.workspaceID === right.workspaceID
  );
}
