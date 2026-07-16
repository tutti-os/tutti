export interface WorkspaceQueryCacheEntry<TValue> {
  readonly resolvedAtUnixMs: number;
  readonly stale: boolean;
  readonly value: TValue;
  readonly version: number;
}

export interface WorkspaceQueryCache<TValue> {
  invalidate(key?: string): void;
  read(key: string): WorkspaceQueryCacheEntry<TValue> | null;
  request(
    key: string,
    load: () => Promise<TValue>
  ): Promise<WorkspaceQueryCacheEntry<TValue>>;
  write(key: string, value: TValue): WorkspaceQueryCacheEntry<TValue>;
}

type MutableWorkspaceQueryCacheEntry<TValue> = Omit<
  WorkspaceQueryCacheEntry<TValue>,
  "stale"
> & { stale: boolean };

const DEFAULT_MAX_ENTRIES = 24;

export function createWorkspaceQueryCache<TValue>(options?: {
  maxEntries?: number;
  now?: () => number;
}): WorkspaceQueryCache<TValue> {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options?.now ?? Date.now;
  const entries = new Map<string, MutableWorkspaceQueryCacheEntry<TValue>>();
  const requests = new Map<string, Promise<WorkspaceQueryCacheEntry<TValue>>>();
  let version = 0;

  const touch = (
    key: string,
    entry: MutableWorkspaceQueryCacheEntry<TValue>
  ): void => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const trim = (): void => {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (typeof oldestKey !== "string") return;
      entries.delete(oldestKey);
    }
  };

  const write = (
    key: string,
    value: TValue
  ): MutableWorkspaceQueryCacheEntry<TValue> => {
    const entry: MutableWorkspaceQueryCacheEntry<TValue> = {
      resolvedAtUnixMs: now(),
      stale: false,
      value,
      version: ++version
    };
    touch(key, entry);
    trim();
    return entry;
  };

  return {
    invalidate(key) {
      if (key !== undefined) {
        const entry = entries.get(key);
        if (entry) entry.stale = true;
        return;
      }
      for (const entry of entries.values()) entry.stale = true;
    },
    read(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      touch(key, entry);
      return entry;
    },
    request(key, load) {
      const active = requests.get(key);
      if (active) return active;
      const request = load()
        .then((value): WorkspaceQueryCacheEntry<TValue> => {
          return write(key, value);
        })
        .finally(() => {
          if (requests.get(key) === request) requests.delete(key);
        });
      requests.set(key, request);
      return request;
    },
    write(key, value) {
      return write(key, value);
    }
  };
}
