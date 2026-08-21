import { useCallback, useRef, useState } from "react";

export function useBottomDockPromptDismissal(
  conversationId: string | null,
  activePromptRequestId: string | null
) {
  const promptIdentity = `${conversationId ?? ""}\x00${activePromptRequestId ?? ""}`;
  const occurrenceRef = useRef({ identity: "", value: 0 });
  if (occurrenceRef.current.identity !== promptIdentity) {
    occurrenceRef.current = {
      identity: promptIdentity,
      value: occurrenceRef.current.value + 1
    };
  }
  const promptToken = `${promptIdentity}\x00${occurrenceRef.current.value}`;
  const [dismissedPromptToken, setDismissedPromptToken] = useState<
    string | null
  >(null);
  const dismissPrompt = useCallback(
    (requestId: string) => {
      if (requestId === activePromptRequestId) {
        setDismissedPromptToken(promptToken);
      }
    },
    [activePromptRequestId, promptToken]
  );
  return {
    dismissPrompt,
    promptVisible: dismissedPromptToken !== promptToken
  };
}
