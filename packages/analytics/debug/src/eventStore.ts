import type { AnalyticsTransportEvent } from "@tutti-os/analytics";

export type AnalyticsDebugEvent = AnalyticsTransportEvent;
export type AnalyticsDebugEventSnapshot = readonly AnalyticsDebugEvent[];

export interface AnalyticsDebugEventStoreContract {
  clear(): void;
  getSnapshot(): AnalyticsDebugEventSnapshot;
  recordEvents(events: readonly AnalyticsDebugEvent[]): void;
  subscribe(listener: () => void): () => void;
}

export type AnalyticsDebugEventRedactor = (
  event: AnalyticsDebugEvent
) => AnalyticsDebugEvent | null;

export interface AnalyticsDebugEventStoreOptions {
  maxEvents?: number;
  redact?: AnalyticsDebugEventRedactor;
}

const DEFAULT_MAX_EVENTS = 200;

/**
 * Bounded, in-memory analytics event store.
 *
 * Transport connection and availability policy intentionally stay in the
 * product host. Redaction runs before an event enters the store.
 */
export class AnalyticsDebugEventStore implements AnalyticsDebugEventStoreContract {
  private events: AnalyticsDebugEventSnapshot = Object.freeze([]);
  private readonly listeners = new Set<() => void>();
  private readonly maxEvents: number;
  private readonly redact: AnalyticsDebugEventRedactor;

  constructor(options: AnalyticsDebugEventStoreOptions = {}) {
    this.maxEvents = normalizeMaxEvents(options.maxEvents);
    this.redact = options.redact ?? cloneAnalyticsDebugEvent;
  }

  clear(): void {
    if (this.events.length === 0) {
      return;
    }

    this.events = Object.freeze([]);
    this.emit();
  }

  dispose(): void {
    this.listeners.clear();
  }

  getSnapshot(): AnalyticsDebugEventSnapshot {
    return this.events;
  }

  recordEvents(events: readonly AnalyticsDebugEvent[]): void {
    if (events.length === 0) {
      return;
    }

    const accepted: AnalyticsDebugEvent[] = [];
    for (const event of events) {
      try {
        const redacted = this.redact(cloneAnalyticsDebugEvent(event));
        if (redacted) {
          accepted.push(
            freezeAnalyticsDebugEvent(cloneAnalyticsDebugEvent(redacted))
          );
        }
      } catch {
        // A host redactor must not interrupt event reporting or panel updates.
      }
    }
    if (accepted.length === 0) {
      return;
    }

    this.events = Object.freeze(
      [...this.events, ...accepted].slice(-this.maxEvents)
    );
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One debug consumer must not break reporting or other consumers.
      }
    }
  }
}

function normalizeMaxEvents(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_EVENTS;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      "analytics debug maxEvents must be a positive integer"
    );
  }
  return value;
}

function cloneAnalyticsDebugEvent(
  event: AnalyticsDebugEvent
): AnalyticsDebugEvent {
  return {
    clientTS: event.clientTS,
    name: event.name,
    ...(event.params !== undefined
      ? { params: structuredClone(event.params) }
      : {})
  };
}

function freezeAnalyticsDebugEvent(
  event: AnalyticsDebugEvent
): AnalyticsDebugEvent {
  deepFreeze(event);
  return event;
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    seen.has(value)
  ) {
    return;
  }

  seen.add(value);
  for (const propertyValue of Object.values(value)) {
    deepFreeze(propertyValue, seen);
  }
  Object.freeze(value);
}
