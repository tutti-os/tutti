export interface AgentRichTextContentEditingKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function createAgentRichTextMentionSuggestionSuppression(
  initialValue: string
): {
  isSuppressed: () => boolean;
  releaseForContentEditingKey: (event: AgentRichTextContentEditingKey) => void;
  setRestoredValue: (value: string) => void;
  suppressTextInsertion: (text: string) => void;
} {
  let restoredValue = initialValue.includes("@");
  let transientInsertion = false;

  return {
    isSuppressed: () => restoredValue || transientInsertion,
    releaseForContentEditingKey: (event) => {
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key.length === 1 ||
          event.key === "Backspace" ||
          event.key === "Delete")
      ) {
        restoredValue = false;
      }
    },
    setRestoredValue: (value) => {
      restoredValue = value.includes("@");
    },
    suppressTextInsertion: (text) => {
      transientInsertion = text.includes("@") && !text.endsWith("@");
      if (!transientInsertion) {
        return;
      }
      // timing: keep suppression through the synchronous editor insertion only.
      window.setTimeout(() => {
        transientInsertion = false;
      }, 0);
    }
  };
}
