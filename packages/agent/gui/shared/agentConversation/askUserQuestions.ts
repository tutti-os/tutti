import type { AgentAskUserQuestionVM } from "./contracts/agentAskUserQuestionItemVM";

/**
 * Single source of truth for turning a raw AskUserQuestion tool input's
 * `questions` array into the view-model shape. Both the in-conversation tool
 * projection and the message-center derivation call this, so the two surfaces
 * can never drift on which fields they read or how they default them (the
 * exact class of bug that left the message-center card without its options).
 *
 * Input shape (codex / ACP): each entry may carry `id`, `header`, `question`,
 * `multiSelect`, and `options: [{ label, description }]`. Answers are layered on
 * by the caller (the live projection knows them; a pending prompt has none), so
 * this returns the answer-less base.
 */
export function normalizeAskUserQuestions(
  rawQuestions: unknown,
  options: { missingText?: string } = {}
): AgentAskUserQuestionVM[] {
  const missingText = options.missingText ?? null;
  return arrayValue(rawQuestions).flatMap((value, index) => {
    const question = objectValue(value);
    if (!question) {
      return [];
    }
    return [
      {
        id: stringValue(question.id) ?? `question-${index + 1}`,
        header:
          stringValue(question.header) ??
          missingText ??
          `Question ${index + 1}`,
        question:
          stringValue(question.question) ??
          stringValue(question.header) ??
          missingText ??
          `Question ${index + 1}`,
        options: arrayValue(question.options).flatMap((optionValue) => {
          const option = objectValue(optionValue);
          const label = stringValue(option?.label);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description: stringValue(option?.description) ?? ""
            }
          ];
        }),
        multiSelect: Boolean(question.multiSelect)
      }
    ];
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
