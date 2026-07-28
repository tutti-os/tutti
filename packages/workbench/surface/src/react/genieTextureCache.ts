export interface WorkbenchGenieTextureCacheValue {
  canvas: {
    height: number;
    width: number;
  };
}

export interface WorkbenchGenieTextureCacheLimits {
  maxBytes: number;
  maxEntries: number;
}

export function readWorkbenchGenieTextureCacheEntry<
  TValue extends WorkbenchGenieTextureCacheValue
>(cache: Map<string, TValue>, nodeID: string): TValue | null {
  const value = cache.get(nodeID) ?? null;
  if (!value) {
    return null;
  }
  cache.delete(nodeID);
  cache.set(nodeID, value);
  return value;
}

export function writeWorkbenchGenieTextureCacheEntry<
  TValue extends WorkbenchGenieTextureCacheValue
>(
  cache: Map<string, TValue>,
  nodeID: string,
  value: TValue,
  limits: WorkbenchGenieTextureCacheLimits
): void {
  cache.delete(nodeID);
  cache.set(nodeID, value);
  pruneWorkbenchGenieTextureCache(cache, limits);
}

export function estimateWorkbenchGenieTextureBytes(
  value: WorkbenchGenieTextureCacheValue
): number {
  return Math.max(0, value.canvas.width) * Math.max(0, value.canvas.height) * 4;
}

export function pruneRemovedWorkbenchGenieTextureCacheEntries<
  TValue extends WorkbenchGenieTextureCacheValue
>(cache: Map<string, TValue>, existingNodeIDs: ReadonlySet<string>): void {
  for (const nodeID of cache.keys()) {
    if (!existingNodeIDs.has(nodeID)) {
      cache.delete(nodeID);
    }
  }
}

function pruneWorkbenchGenieTextureCache<
  TValue extends WorkbenchGenieTextureCacheValue
>(cache: Map<string, TValue>, limits: WorkbenchGenieTextureCacheLimits): void {
  let estimatedBytes = 0;
  for (const value of cache.values()) {
    estimatedBytes += estimateWorkbenchGenieTextureBytes(value);
  }
  while (cache.size > limits.maxEntries || estimatedBytes > limits.maxBytes) {
    const oldest = cache.entries().next().value as [string, TValue] | undefined;
    if (!oldest) {
      return;
    }
    cache.delete(oldest[0]);
    estimatedBytes -= estimateWorkbenchGenieTextureBytes(oldest[1]);
  }
}
