import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";

export const AGENT_RICH_TEXT_SKIP_USER_CONTENT_EVENT_META =
  "agentRichTextSkipUserContentEvent";

export function isAgentRichTextUserContentInsertion(
  transaction: Transaction
): boolean {
  if (
    transaction.getMeta(AGENT_RICH_TEXT_SKIP_USER_CONTENT_EVENT_META) ===
      true ||
    isHistoryTransaction(transaction)
  ) {
    return false;
  }
  return transaction.steps.some((step) => {
    let inserted = false;
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd > newStart) inserted = true;
    });
    return inserted;
  });
}

export function markAgentRichTextPointerFocus(ref: {
  current: "pointer" | "programmatic" | null;
}): void {
  ref.current = "pointer";
  queueMicrotask(() => {
    if (ref.current === "pointer") ref.current = null;
  });
}
