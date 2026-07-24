const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_SOURCE_CHARS = 2_000_000;

interface ParsedDocumentCacheEntry {
  source: string;
  value: unknown;
  weight: number;
}

const parsedDocumentCache = new Map<string, ParsedDocumentCacheEntry>();
const parsedDocumentCacheStats = {
  hits: 0,
  misses: 0,
  sourceChars: 0
};

export function readParsedDocumentCache<T>(input: {
  namespace: string;
  identity: string;
  source: string;
  create: () => T;
}): T {
  const key = `${input.namespace}:${input.identity}:${hashCacheSource(input.source)}`;
  const cached = parsedDocumentCache.get(key);
  if (cached?.source === input.source) {
    parsedDocumentCache.delete(key);
    parsedDocumentCache.set(key, cached);
    parsedDocumentCacheStats.hits += 1;
    return cached.value as T;
  }

  parsedDocumentCacheStats.misses += 1;
  const value = input.create();
  if (input.source.length > MAX_CACHE_SOURCE_CHARS) {
    return value;
  }
  if (cached) {
    parsedDocumentCache.delete(key);
    parsedDocumentCacheStats.sourceChars -= cached.weight;
  }
  const entry = {
    source: input.source,
    value,
    weight: input.source.length
  };
  parsedDocumentCache.set(key, entry);
  parsedDocumentCacheStats.sourceChars += entry.weight;
  trimParsedDocumentCache();
  return value;
}

export function resetParsedDocumentCacheForTests(): void {
  parsedDocumentCache.clear();
  parsedDocumentCacheStats.hits = 0;
  parsedDocumentCacheStats.misses = 0;
  parsedDocumentCacheStats.sourceChars = 0;
}

export function parsedDocumentCacheStatsForTests(): {
  entries: number;
  hits: number;
  misses: number;
  sourceChars: number;
} {
  return {
    entries: parsedDocumentCache.size,
    hits: parsedDocumentCacheStats.hits,
    misses: parsedDocumentCacheStats.misses,
    sourceChars: parsedDocumentCacheStats.sourceChars
  };
}

function trimParsedDocumentCache(): void {
  while (
    parsedDocumentCache.size > MAX_CACHE_ENTRIES ||
    parsedDocumentCacheStats.sourceChars > MAX_CACHE_SOURCE_CHARS
  ) {
    const oldest = parsedDocumentCache.entries().next().value as
      | [string, ParsedDocumentCacheEntry]
      | undefined;
    if (!oldest) {
      return;
    }
    parsedDocumentCache.delete(oldest[0]);
    parsedDocumentCacheStats.sourceChars -= oldest[1].weight;
  }
}

function hashCacheSource(source: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${source.length}:${hash >>> 0}`;
}
