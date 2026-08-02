import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry
} from "@anthropic-ai/claude-agent-sdk";
import { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";

type TranscriptEntryObserver = (
  key: SessionKey,
  entries: readonly SessionStoreEntry[],
  source: TranscriptObservationSource
) => void;

export type NativeTranscriptReplay = typeof importSessionToStore;
export type TranscriptObservationSource = "live_mirror" | "native_replay";

type NativeTranscriptReplayOptions = {
  signal?: AbortSignal;
};

/**
 * Receives the SDK's official transcript mirror without becoming a second
 * persistence owner. Returning no stored history keeps explicit resume on
 * Claude's existing local store; append is only a live observation boundary.
 */
export class TranscriptObservationStore implements SessionStore {
  private readonly projectDirectory: string;
  private readonly observe: TranscriptEntryObserver;
  private readonly replayNativeSession: NativeTranscriptReplay;

  constructor(
    projectDirectory: string,
    observe: TranscriptEntryObserver,
    replayNativeSession: NativeTranscriptReplay = importSessionToStore
  ) {
    this.projectDirectory = projectDirectory;
    this.observe = observe;
    this.replayNativeSession = replayNativeSession;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.observe(key, entries, "live_mirror");
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (!key.subpath && key.sessionId.trim()) {
      try {
        await this.replay(key.sessionId);
      } catch {
        // Observation is best effort. Native Claude resume remains the source
        // of truth and must not be blocked by a replay/import failure.
      }
    }
    // This store is an observer, not the resume persistence owner. Returning
    // null keeps the SDK attached to Claude's original local JSONL path.
    return null;
  }

  async replay(
    sessionId: string,
    options: NativeTranscriptReplayOptions = {}
  ): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    const batches = new Map<
      string,
      { key: SessionKey; entries: SessionStoreEntry[] }
    >();
    let acceptingEntries = true;
    const replayObserver: SessionStore = {
      append: async (key, entries) => {
        if (!acceptingEntries || options.signal?.aborted) {
          return;
        }
        const id = transcriptKeyId(key);
        const batch = batches.get(id);
        if (batch) {
          batch.entries.push(...entries);
        } else {
          batches.set(id, { key, entries: [...entries] });
        }
      },
      load: async () => null
    };
    try {
      await waitForReplay(
        this.replayNativeSession(normalizedSessionId, replayObserver, {
          dir: this.projectDirectory,
          includeSubagents: false
        }),
        options.signal
      );
      if (options.signal?.aborted) {
        throw replayAbortError(options.signal);
      }
      for (const { key, entries } of batches.values()) {
        this.observe(key, entries, "native_replay");
      }
    } finally {
      // A timed-out SDK import cannot publish late partial observations after
      // the owning Turn has already continued to settlement.
      acceptingEntries = false;
    }
  }
}

function transcriptKeyId(key: SessionKey): string {
  return `${key.projectKey}\u0000${key.sessionId}\u0000${key.subpath ?? ""}`;
}

async function waitForReplay(
  replay: Promise<unknown>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    await replay;
    return;
  }
  if (signal.aborted) {
    throw replayAbortError(signal);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(replayAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([replay, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function replayAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Claude transcript replay aborted", "AbortError");
}
