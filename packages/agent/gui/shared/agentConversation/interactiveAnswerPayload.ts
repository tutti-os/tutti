/**
 * Wire contract for the answer submitted back to an interactive `ask-user`
 * prompt. This payload crosses the renderer → daemon boundary (it rides
 * `submitInteractive({ action: "submit", payload })`), so its shape is a
 * cross-language contract, not an internal detail.
 *
 * Consumers that MUST stay in sync with this shape:
 * - daemon (Go) standard ACP adapter — forwards `answersByQuestionId` verbatim.
 * - daemon (Go) codex app-server adapter — `appServerUserInputAnswers` reshapes
 *   `answersByQuestionId` into codex's `requestUserInput` response.
 *
 * Field semantics:
 * - `answersByQuestionId` is the canonical, machine-readable answer: question id
 *   → the chosen option label(s) / free text. This is what providers consume.
 * - `answers` is a flat, human-readable display list (one entry per answered
 *   question, multi-select joined). Never the source of truth for routing.
 *
 * Always build this with {@link buildAskUserAnswerPayload} so producers can't
 * drift on field names or which field is authoritative.
 */
export interface InteractiveAnswerPayload {
  answers: string[];
  answersByQuestionId: Record<string, string | string[]>;
}

export function readOwnAnswer<T>(
  values: Record<string, T>,
  questionID: string,
  fallback: T
): T {
  return Object.prototype.hasOwnProperty.call(values, questionID)
    ? values[questionID]!
    : fallback;
}

export function writeOwnAnswer<T>(
  values: Record<string, T>,
  questionID: string,
  value: T
): void {
  Object.defineProperty(values, questionID, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

/**
 * Builds the canonical interactive answer payload from the per-question answers.
 * `answers` is derived from `answersByQuestionId` (multi-select values joined)
 * so the two fields can never disagree.
 */
export function buildAskUserAnswerPayload(
  answersByQuestionId: Record<string, string | string[]>
): InteractiveAnswerPayload {
  const answers = Object.values(answersByQuestionId).map((value) =>
    Array.isArray(value) ? value.join(", ") : value
  );
  return { answers, answersByQuestionId };
}
