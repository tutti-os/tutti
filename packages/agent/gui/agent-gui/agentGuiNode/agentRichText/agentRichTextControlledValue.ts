interface PendingLocalPromptEcho {
  revision: number;
  scopeKey: string;
  value: string;
}

export interface AgentRichTextControlledValueTracker {
  nextRevision: number;
  pendingLocalEchoes: PendingLocalPromptEcho[];
  scopeKey: string;
}

export function createAgentRichTextControlledValueTracker(
  scopeKey: string
): AgentRichTextControlledValueTracker {
  return { nextRevision: 0, pendingLocalEchoes: [], scopeKey };
}

export function recordAgentRichTextLocalEdit(
  tracker: AgentRichTextControlledValueTracker,
  value: string
): void {
  tracker.nextRevision += 1;
  tracker.pendingLocalEchoes.push({
    revision: tracker.nextRevision,
    scopeKey: tracker.scopeKey,
    value
  });
}

export function shouldApplyAgentRichTextControlledValue(input: {
  lastEmittedValue: string | null;
  scopeKey: string;
  tracker: AgentRichTextControlledValueTracker;
  value: string;
}): boolean {
  const { lastEmittedValue, scopeKey, tracker, value } = input;
  const scopeChanged = tracker.scopeKey !== scopeKey;
  if (scopeChanged) {
    tracker.scopeKey = scopeKey;
    tracker.pendingLocalEchoes = [];
  }
  const localEcho = tracker.pendingLocalEchoes.find(
    (candidate) => candidate.scopeKey === scopeKey && candidate.value === value
  );
  if (!scopeChanged && localEcho) {
    tracker.pendingLocalEchoes = tracker.pendingLocalEchoes.filter(
      (candidate) =>
        candidate.scopeKey !== scopeKey ||
        candidate.revision > localEcho.revision
    );
    return false;
  }
  if (!scopeChanged && value === lastEmittedValue) {
    return false;
  }
  tracker.pendingLocalEchoes = [];
  return true;
}
