import { useCallback, useMemo, useState } from "react";
import type { AgentAskUserQuestionVM } from "../contracts/agentAskUserQuestionItemVM";
import {
  buildAskUserAnswerPayload,
  type InteractiveAnswerPayload
} from "../interactiveAnswerPayload";

export interface AskUserAnswerFlow {
  allQuestionsAnswered: boolean;
  answerPayload: InteractiveAnswerPayload;
  currentIndex: number;
  currentQuestion: AgentAskUserQuestionVM | null;
  currentQuestionAnswered: boolean;
  freeText: string;
  isLastQuestion: boolean;
  selectedOptions: string[];
  goToNextQuestion: () => void;
  goToPreviousQuestion: () => void;
  setFreeText: (value: string) => void;
  toggleOption: (optionLabel: string) => void;
}

function readOwnValue<T>(
  values: Record<string, T>,
  key: string,
  fallback: T
): T {
  return Object.prototype.hasOwnProperty.call(values, key)
    ? values[key]!
    : fallback;
}

function writeOwnValue<T>(
  values: Record<string, T>,
  key: string,
  value: T
): void {
  Object.defineProperty(values, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

export function useAskUserAnswerFlow({
  isSubmitting,
  questions
}: {
  isSubmitting: boolean;
  questions: AgentAskUserQuestionVM[];
}): AskUserAnswerFlow {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedByQuestionId, setSelectedByQuestionId] = useState<
    Record<string, string[]>
  >({});
  const [freeTextByQuestionId, setFreeTextByQuestionId] = useState<
    Record<string, string>
  >({});

  const currentQuestion = questions[currentIndex] ?? null;
  const selectedOptions = currentQuestion
    ? readOwnValue(selectedByQuestionId, currentQuestion.id, [])
    : [];
  const freeText = currentQuestion
    ? readOwnValue(freeTextByQuestionId, currentQuestion.id, "")
    : "";
  const currentQuestionAnswered =
    currentQuestion !== null &&
    (selectedOptions.length > 0 || freeText.trim() !== "");
  const isLastQuestion = currentIndex >= questions.length - 1;

  const answerPayload = useMemo(() => {
    const answersByQuestionId: Record<string, string | string[]> = {};
    for (const question of questions) {
      const selected = readOwnValue(selectedByQuestionId, question.id, []);
      const customAnswer = readOwnValue(
        freeTextByQuestionId,
        question.id,
        ""
      ).trim();
      if (question.multiSelect) {
        const answers = customAnswer ? [...selected, customAnswer] : selected;
        if (answers.length > 0) {
          writeOwnValue(answersByQuestionId, question.id, answers);
        }
        continue;
      }
      const answer = customAnswer || selected[0];
      if (answer) {
        writeOwnValue(answersByQuestionId, question.id, answer);
      }
    }
    return buildAskUserAnswerPayload(answersByQuestionId);
  }, [freeTextByQuestionId, questions, selectedByQuestionId]);

  const allQuestionsAnswered =
    questions.length > 0 &&
    questions.every((question) =>
      Object.prototype.hasOwnProperty.call(
        answerPayload.answersByQuestionId,
        question.id
      )
    );

  const toggleOption = useCallback(
    (optionLabel: string) => {
      if (isSubmitting || !currentQuestion) return;
      setSelectedByQuestionId((current) => {
        const existing = readOwnValue(current, currentQuestion.id, []);
        const next = currentQuestion.multiSelect
          ? existing.includes(optionLabel)
            ? existing.filter((value) => value !== optionLabel)
            : [...existing, optionLabel]
          : existing.includes(optionLabel)
            ? []
            : [optionLabel];
        const updated = { ...current };
        writeOwnValue(updated, currentQuestion.id, next);
        return updated;
      });
    },
    [currentQuestion, isSubmitting]
  );

  const setFreeText = useCallback(
    (value: string) => {
      if (isSubmitting || !currentQuestion) return;
      setFreeTextByQuestionId((current) => {
        const updated = { ...current };
        writeOwnValue(updated, currentQuestion.id, value);
        return updated;
      });
    },
    [currentQuestion, isSubmitting]
  );

  const goToPreviousQuestion = useCallback(() => {
    if (isSubmitting) return;
    setCurrentIndex((current) => Math.max(current - 1, 0));
  }, [isSubmitting]);

  const goToNextQuestion = useCallback(() => {
    if (isSubmitting || !currentQuestionAnswered) return;
    setCurrentIndex((current) => Math.min(current + 1, questions.length - 1));
  }, [currentQuestionAnswered, isSubmitting, questions.length]);

  return {
    allQuestionsAnswered,
    answerPayload,
    currentIndex,
    currentQuestion,
    currentQuestionAnswered,
    freeText,
    isLastQuestion,
    selectedOptions,
    goToNextQuestion,
    goToPreviousQuestion,
    setFreeText,
    toggleOption
  };
}
