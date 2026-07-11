const pendingCreateConversationIdsByQueryKey = new Map<
  string,
  Map<string, string>
>();

export function markAgentGUIConversationCreatePendingState(input: {
  queryKey: string | null;
  ownerKey: string;
  conversationId: string;
}): boolean {
  const ownerKey = input.ownerKey.trim();
  const conversationId = input.conversationId.trim();
  if (!input.queryKey || !ownerKey || !conversationId) {
    return false;
  }
  const pendingIds =
    pendingCreateConversationIdsByQueryKey.get(input.queryKey) ??
    new Map<string, string>();
  if (pendingIds.get(ownerKey) === conversationId) {
    return false;
  }
  pendingIds.set(ownerKey, conversationId);
  pendingCreateConversationIdsByQueryKey.set(input.queryKey, pendingIds);
  return true;
}

export function clearAgentGUIConversationCreatePendingState(input: {
  queryKey: string | null;
  ownerKey: string;
  conversationId?: string | null;
}): boolean {
  const ownerKey = input.ownerKey.trim();
  if (!input.queryKey || !ownerKey) {
    return false;
  }
  const expectedConversationId = input.conversationId?.trim() ?? "";
  const pendingIds = pendingCreateConversationIdsByQueryKey.get(input.queryKey);
  const currentConversationId = pendingIds?.get(ownerKey)?.trim() ?? "";
  if (!currentConversationId) {
    return false;
  }
  if (
    expectedConversationId &&
    currentConversationId !== expectedConversationId
  ) {
    return false;
  }
  pendingIds?.delete(ownerKey);
  if (!pendingIds || pendingIds.size === 0) {
    pendingCreateConversationIdsByQueryKey.delete(input.queryKey);
  }
  return true;
}

export function getAgentGUIConversationCreatePendingState(input: {
  queryKey: string | null;
  ownerKey: string;
}): string | null {
  const ownerKey = input.ownerKey.trim();
  if (!input.queryKey || !ownerKey) {
    return null;
  }
  return (
    pendingCreateConversationIdsByQueryKey.get(input.queryKey)?.get(ownerKey) ??
    null
  );
}

export function resetAgentGUIConversationPendingStateForTests(): void {
  pendingCreateConversationIdsByQueryKey.clear();
}
