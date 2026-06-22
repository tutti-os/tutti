// Module-level store owning the per-controller "new conversation" lifecycle
// bookkeeping that previously lived as scattered refs inside
// useAgentGUINodeController (startingConversationId, the activated/failed id
// sets). These values are read synchronously inside async callbacks and are
// never rendered, so this is a plain keyed store rather than a
// useSyncExternalStore source — which is exactly why the controller used refs
// for them. Moving them here removes the ref bookkeeping from the controller
// and makes the creation lifecycle testable in isolation.
//
// Keyed by a stable controller owner key (the node id, or a generated id for
// detached controllers). The owner entry is cleared when the controller
// unmounts so semantics match the previous per-instance refs.

interface ConversationCreationOwnerState {
  startingConversationId: string | null;
  activatedConversationIds: Set<string>;
  failedNewConversationIds: Set<string>;
}

const ownerStatesByKey = new Map<string, ConversationCreationOwnerState>();

function ensureOwnerState(ownerKey: string): ConversationCreationOwnerState {
  let state = ownerStatesByKey.get(ownerKey);
  if (!state) {
    state = {
      startingConversationId: null,
      activatedConversationIds: new Set<string>(),
      failedNewConversationIds: new Set<string>()
    };
    ownerStatesByKey.set(ownerKey, state);
  }
  return state;
}

// --- starting conversation id (the create currently in flight) ---

export function setStartingConversationId(
  ownerKey: string,
  conversationId: string | null
): void {
  if (conversationId === null) {
    const state = ownerStatesByKey.get(ownerKey);
    if (state) {
      state.startingConversationId = null;
    }
    return;
  }
  ensureOwnerState(ownerKey).startingConversationId = conversationId;
}

export function getStartingConversationId(ownerKey: string): string | null {
  return ownerStatesByKey.get(ownerKey)?.startingConversationId ?? null;
}

// --- activated conversations (successfully attached) ---

export function markActivatedConversation(
  ownerKey: string,
  conversationId: string
): void {
  ensureOwnerState(ownerKey).activatedConversationIds.add(conversationId);
}

export function unmarkActivatedConversation(
  ownerKey: string,
  conversationId: string
): void {
  ownerStatesByKey
    .get(ownerKey)
    ?.activatedConversationIds.delete(conversationId);
}

export function isActivatedConversation(
  ownerKey: string,
  conversationId: string
): boolean {
  return (
    ownerStatesByKey
      .get(ownerKey)
      ?.activatedConversationIds.has(conversationId) ?? false
  );
}

// --- failed new conversations (creation rejected) ---

export function markFailedNewConversation(
  ownerKey: string,
  conversationId: string
): void {
  ensureOwnerState(ownerKey).failedNewConversationIds.add(conversationId);
}

export function clearFailedNewConversation(
  ownerKey: string,
  conversationId: string
): void {
  ownerStatesByKey
    .get(ownerKey)
    ?.failedNewConversationIds.delete(conversationId);
}

export function isFailedNewConversation(
  ownerKey: string,
  conversationId: string
): boolean {
  return (
    ownerStatesByKey
      .get(ownerKey)
      ?.failedNewConversationIds.has(conversationId) ?? false
  );
}

// --- lifecycle ---

export function clearConversationCreationOwner(ownerKey: string): void {
  ownerStatesByKey.delete(ownerKey);
}

export function resetConversationCreationStoreForTests(): void {
  ownerStatesByKey.clear();
}
