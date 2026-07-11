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

export interface WorkspaceAppLaunchIntentDelivery {
  enqueuedAtMs: number;
  intent: TuttiExternalWorkspaceOpenRouteIntent;
  order: number;
  ownerWebContentsId: number;
}

interface WorkspaceAppLaunchIntentQueueTarget extends WorkspaceAppLaunchIntentTarget {
  recipientWebContentsId?: number;
}

export const workspaceAppLaunchIntentQueueDefaults = Object.freeze({
  maxIntentsPerTarget: 32,
  maxTargets: 128,
  maxTotalIntents: 512,
  ttlMs: 5 * 60 * 1000
});

export class WorkspaceAppLaunchIntentQueue {
  readonly #entries = new Map<string, WorkspaceAppLaunchIntentDelivery[]>();
  readonly #maxIntentsPerTarget: number;
  readonly #maxTargets: number;
  readonly #maxTotalIntents: number;
  #nextOrder = 0;
  #nextPrependOrder = -1;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options?: {
    maxIntentsPerTarget?: number;
    maxTargets?: number;
    maxTotalIntents?: number;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.#maxIntentsPerTarget = requirePositiveInteger(
      options?.maxIntentsPerTarget ??
        workspaceAppLaunchIntentQueueDefaults.maxIntentsPerTarget,
      "maxIntentsPerTarget"
    );
    this.#maxTargets = requirePositiveInteger(
      options?.maxTargets ?? workspaceAppLaunchIntentQueueDefaults.maxTargets,
      "maxTargets"
    );
    this.#maxTotalIntents = requirePositiveInteger(
      options?.maxTotalIntents ??
        workspaceAppLaunchIntentQueueDefaults.maxTotalIntents,
      "maxTotalIntents"
    );
    this.#now = options?.now ?? Date.now;
    this.#ttlMs = requireNonNegativeFiniteNumber(
      options?.ttlMs ?? workspaceAppLaunchIntentQueueDefaults.ttlMs,
      "ttlMs"
    );
  }

  clearOwner(ownerWebContentsId: number): void {
    for (const [key, entries] of this.#entries) {
      if (entries[0]?.ownerWebContentsId === ownerWebContentsId) {
        this.#entries.delete(key);
      }
    }
  }

  drain(target: WorkspaceAppLaunchIntentTarget) {
    return this.drainDeliveries(target).map((entry) => entry.intent);
  }

  drainDeliveries(
    target: WorkspaceAppLaunchIntentQueueTarget
  ): WorkspaceAppLaunchIntentDelivery[] {
    this.#prune();
    const key = launchIntentTargetKey(target);
    const entries = this.#entries.get(key) ?? [];
    this.#entries.delete(key);
    return entries;
  }

  enqueue(
    target: WorkspaceAppLaunchIntentQueueTarget,
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
      order: this.#nextOrder++,
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
    target: WorkspaceAppLaunchIntentQueueTarget,
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
      order: this.#nextPrependOrder--,
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
    target: WorkspaceAppLaunchIntentQueueTarget
  ): TuttiExternalWorkspaceOpenRouteIntent | undefined {
    return this.shiftDelivery(target)?.intent;
  }

  shiftDelivery(
    target: WorkspaceAppLaunchIntentQueueTarget
  ): WorkspaceAppLaunchIntentDelivery | undefined {
    this.#prune();
    const key = launchIntentTargetKey(target);
    const entries = this.#entries.get(key);
    const delivery = entries?.shift();
    if (!entries || entries.length === 0) {
      this.#entries.delete(key);
    }
    return delivery;
  }

  restore(
    target: WorkspaceAppLaunchIntentQueueTarget,
    deliveries: readonly WorkspaceAppLaunchIntentDelivery[]
  ): void {
    this.#prune();
    const expiresBefore = this.#now() - this.#ttlMs;
    const retained = deliveries.filter(
      (delivery) => delivery.enqueuedAtMs > expiresBefore
    );
    if (retained.length === 0) {
      return;
    }
    const key = launchIntentTargetKey(target);
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxTargets) {
      this.#evictOldestTarget();
    }
    const merged = [...(this.#entries.get(key) ?? []), ...retained].sort(
      (left, right) => left.order - right.order
    );
    while (merged.length > this.#maxIntentsPerTarget) {
      merged.shift();
    }
    this.#entries.set(key, merged);
    while (this.#totalIntents() > this.#maxTotalIntents) {
      this.#evictOldestIntent();
    }
  }

  transfer(
    source: WorkspaceAppLaunchIntentQueueTarget,
    target: WorkspaceAppLaunchIntentQueueTarget
  ): void {
    this.#prune();
    const sourceKey = launchIntentTargetKey(source);
    const entries = this.#entries.get(sourceKey);
    if (!entries || entries.length === 0) {
      return;
    }
    this.#entries.delete(sourceKey);
    const targetKey = launchIntentTargetKey(target);
    const merged = [...(this.#entries.get(targetKey) ?? []), ...entries].sort(
      (left, right) => left.order - right.order
    );
    while (merged.length > this.#maxIntentsPerTarget) {
      merged.shift();
    }
    this.#entries.set(targetKey, merged);
  }

  get size(): number {
    this.#prune();
    return this.#totalIntents();
  }

  has(target: WorkspaceAppLaunchIntentQueueTarget): boolean {
    this.#prune();
    return this.#entries.has(launchIntentTargetKey(target));
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

interface WorkspaceAppLaunchIntentReplacementBacklogs {
  recipientWebContentsIds: number[];
  target: WorkspaceAppLaunchIntentTarget;
}

export class WorkspaceAppLaunchIntentDeliveryState {
  readonly #guests = new Map<number, WorkspaceAppLaunchIntentGuest>();
  readonly #queue: WorkspaceAppLaunchIntentQueue;
  readonly #replacementBacklogs = new Map<
    string,
    WorkspaceAppLaunchIntentReplacementBacklogs
  >();

  constructor(
    options?: ConstructorParameters<typeof WorkspaceAppLaunchIntentQueue>[0]
  ) {
    this.#queue = new WorkspaceAppLaunchIntentQueue(options);
  }

  clearOwner(ownerWebContentsId: number): void {
    this.#queue.clearOwner(ownerWebContentsId);
    for (const [key, backlog] of this.#replacementBacklogs) {
      if (backlog.target.ownerWebContentsId === ownerWebContentsId) {
        this.#replacementBacklogs.delete(key);
      }
    }
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

  markDeliveryFailed(
    guestWebContentsId: number,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): void {
    const guest = this.#guests.get(guestWebContentsId);
    if (!guest) {
      return;
    }
    guest.ready = false;
    this.#queue.enqueue(
      recipientTarget(guest.target, guestWebContentsId),
      intent
    );
  }

  restoreFailedDeliveries(
    guestWebContentsId: number,
    deliveries: readonly WorkspaceAppLaunchIntentDelivery[]
  ): void {
    const guest = this.#guests.get(guestWebContentsId);
    if (!guest) {
      return;
    }
    guest.ready = false;
    this.#queue.restore(
      recipientTarget(guest.target, guestWebContentsId),
      deliveries
    );
  }

  markReady(guestWebContentsId: number): WorkspaceAppLaunchIntentDelivery[] {
    const guest = this.#guests.get(guestWebContentsId);
    if (!guest) {
      return [];
    }
    guest.ready = true;
    return [
      ...this.#queue.drainDeliveries(guest.target),
      ...this.#queue.drainDeliveries(
        recipientTarget(guest.target, guestWebContentsId)
      )
    ];
  }

  registerGuest(
    guestWebContentsId: number,
    target: WorkspaceAppLaunchIntentTarget
  ): WorkspaceAppLaunchIntentDelivery | undefined {
    this.#guests.set(guestWebContentsId, { ready: false, target });
    const replacementInitial = this.#claimReplacementBacklog(
      guestWebContentsId,
      target
    );
    if (replacementInitial) {
      return replacementInitial;
    }
    return this.#queue.shiftDelivery(target);
  }

  removeGuest(
    guestWebContentsId: number,
    unconsumedInitial?: WorkspaceAppLaunchIntentDelivery
  ): void {
    const guest = this.#guests.get(guestWebContentsId);
    this.#guests.delete(guestWebContentsId);
    if (!guest) {
      return;
    }
    const recipient = recipientTarget(guest.target, guestWebContentsId);
    if (unconsumedInitial) {
      this.#queue.restore(recipient, [unconsumedInitial]);
    }
    if (this.#queue.has(recipient)) {
      this.#cleanupReplacementBacklogs();
      const key = launchIntentTargetKey(guest.target);
      const backlog = this.#replacementBacklogs.get(key) ?? {
        recipientWebContentsIds: [],
        target: guest.target
      };
      backlog.recipientWebContentsIds.push(guestWebContentsId);
      this.#replacementBacklogs.set(key, backlog);
    }
  }

  route(
    target: WorkspaceAppLaunchIntentTarget,
    intent: TuttiExternalWorkspaceOpenRouteIntent
  ): number[] {
    const readyGuests: number[] = [];
    let matchingGuestCount = 0;
    for (const [guestWebContentsId, guest] of this.#guests) {
      if (!targetsEqual(guest.target, target)) {
        continue;
      }
      matchingGuestCount += 1;
      if (guest.ready) {
        readyGuests.push(guestWebContentsId);
      } else {
        this.#queue.enqueue(
          recipientTarget(target, guestWebContentsId),
          intent
        );
      }
    }
    if (matchingGuestCount === 0) {
      this.#queue.enqueue(target, intent);
    }
    return readyGuests;
  }

  get queuedIntentCount(): number {
    this.#cleanupReplacementBacklogs();
    return this.#queue.size;
  }

  #claimReplacementBacklog(
    guestWebContentsId: number,
    target: WorkspaceAppLaunchIntentTarget
  ): WorkspaceAppLaunchIntentDelivery | undefined {
    this.#cleanupReplacementBacklogs();
    const key = launchIntentTargetKey(target);
    const backlog = this.#replacementBacklogs.get(key);
    if (!backlog) {
      return undefined;
    }
    while (backlog.recipientWebContentsIds.length > 0) {
      const replacedGuestWebContentsId =
        backlog.recipientWebContentsIds.shift();
      if (replacedGuestWebContentsId === undefined) {
        break;
      }
      const recipient = recipientTarget(target, guestWebContentsId);
      this.#queue.transfer(
        recipientTarget(target, replacedGuestWebContentsId),
        recipient
      );
      if (!this.#queue.has(recipient)) {
        continue;
      }
      // Intents emitted while no matching guest existed are newer than the
      // replaced guest's backlog, so append the global lane before delivery.
      this.#queue.transfer(target, recipient);
      if (backlog.recipientWebContentsIds.length === 0) {
        this.#replacementBacklogs.delete(key);
      }
      return this.#queue.shiftDelivery(recipient);
    }
    this.#replacementBacklogs.delete(key);
    return undefined;
  }

  #cleanupReplacementBacklogs(): void {
    for (const [key, backlog] of this.#replacementBacklogs) {
      backlog.recipientWebContentsIds = backlog.recipientWebContentsIds.filter(
        (guestWebContentsId) =>
          this.#queue.has(recipientTarget(backlog.target, guestWebContentsId))
      );
      if (backlog.recipientWebContentsIds.length === 0) {
        this.#replacementBacklogs.delete(key);
      }
    }
  }
}

function launchIntentTargetKey(
  target: WorkspaceAppLaunchIntentQueueTarget
): string {
  return [
    String(target.ownerWebContentsId),
    encodeURIComponent(target.workspaceID),
    encodeURIComponent(target.appID),
    target.recipientWebContentsId === undefined
      ? "target"
      : `guest:${String(target.recipientWebContentsId)}`
  ].join(":");
}

function recipientTarget(
  target: WorkspaceAppLaunchIntentTarget,
  guestWebContentsId: number
): WorkspaceAppLaunchIntentQueueTarget {
  return { ...target, recipientWebContentsId: guestWebContentsId };
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number.`);
  }
  return value;
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
