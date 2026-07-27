import type { AgentComposerDraft } from "./agentGuiNodeTypes";
import {
  agentComposerDraftHasContent,
  snapshotAgentComposerDraft
} from "./agentComposerDraft";

export interface AgentComposerInputHistoryEntry {
  id: string;
  draft: AgentComposerDraft;
}

export interface AgentComposerInputHistoryStore {
  entries: AgentComposerInputHistoryEntry[];
  nextEntryId: number;
}

export interface AgentComposerInputHistoryState {
  entryId: string | null;
  currentDraft: AgentComposerDraft | null;
}

export interface AgentComposerInputHistoryNavigation {
  draft?: AgentComposerDraft;
  handled: boolean;
  state: AgentComposerInputHistoryState;
}

export const EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE: AgentComposerInputHistoryState =
  {
    entryId: null,
    currentDraft: null
  };

export function createAgentComposerInputHistoryStore(): AgentComposerInputHistoryStore {
  return {
    entries: [],
    nextEntryId: 1
  };
}

export function recordAgentComposerInputHistory(
  store: AgentComposerInputHistoryStore,
  draft: AgentComposerDraft
): boolean {
  if (!agentComposerDraftHasContent(draft)) {
    return false;
  }
  store.entries.push({
    id: `open:${store.nextEntryId}`,
    draft: snapshotAgentComposerDraft(draft)
  });
  store.nextEntryId += 1;
  return true;
}

export function navigateAgentComposerInputHistory(input: {
  currentDraft: AgentComposerDraft;
  direction: "older" | "newer";
  entries: readonly AgentComposerInputHistoryEntry[];
  state: AgentComposerInputHistoryState;
}): AgentComposerInputHistoryNavigation {
  let currentIndex = input.state.entryId
    ? input.entries.findIndex((entry) => entry.id === input.state.entryId)
    : -1;
  let currentDraft = input.state.currentDraft;
  if (
    input.state.entryId &&
    (currentIndex < 0 ||
      !areAgentComposerHistoryDraftsEqual(
        input.currentDraft,
        input.entries[currentIndex]!.draft
      ))
  ) {
    currentIndex = -1;
    currentDraft = null;
  }

  if (currentIndex < 0) {
    if (input.direction === "newer") {
      return unhandledHistoryNavigation();
    }
    const latest = input.entries.at(-1);
    return latest
      ? recalledHistoryNavigation(latest, input.currentDraft)
      : unhandledHistoryNavigation();
  }

  if (input.direction === "older") {
    const older = input.entries[currentIndex - 1];
    return older
      ? recalledHistoryNavigation(older, currentDraft)
      : {
          handled: false,
          state: {
            entryId: input.state.entryId,
            currentDraft
          }
        };
  }

  const newer = input.entries[currentIndex + 1];
  if (newer) {
    return recalledHistoryNavigation(newer, currentDraft);
  }
  return {
    draft: currentDraft
      ? snapshotAgentComposerDraft(currentDraft)
      : snapshotAgentComposerDraft(input.currentDraft),
    handled: true,
    state: EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE
  };
}

export function areAgentComposerHistoryDraftsEqual(
  left: AgentComposerDraft,
  right: AgentComposerDraft
): boolean {
  return historyDraftValue(left) === historyDraftValue(right);
}

function recalledHistoryNavigation(
  entry: AgentComposerInputHistoryEntry,
  currentDraft: AgentComposerDraft | null
): AgentComposerInputHistoryNavigation {
  return {
    draft: snapshotAgentComposerDraft(entry.draft),
    handled: true,
    state: {
      entryId: entry.id,
      currentDraft:
        currentDraft === null ? null : snapshotAgentComposerDraft(currentDraft)
    }
  };
}

function unhandledHistoryNavigation(): AgentComposerInputHistoryNavigation {
  return {
    handled: false,
    state: EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE
  };
}

function historyDraftValue(draft: AgentComposerDraft): string {
  return JSON.stringify(
    draft.map((block) =>
      block.type === "image"
        ? {
            ...block,
            // Preview data is presentation-only and may arrive asynchronously.
            previewUrl: ""
          }
        : block
    )
  );
}
