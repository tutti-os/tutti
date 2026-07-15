import type { JSX } from "react";
import { Button } from "@tutti-os/ui-system";
import { MessageSquareMoreIcon } from "../../../app/renderer/components/icons/MessageSquareMoreIcon";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import type { AgentConversationPromptVM } from "../contracts/agentConversationVM";
import { buildAskUserAnswerPayload } from "../interactiveAnswerPayload";
import type {
  AgentInteractivePromptSurfaceProps,
  AgentInteractivePromptVariant
} from "./AgentInteractivePromptSurface";
import {
  interactiveOptionLabel,
  interactivePromptCardClassName,
  interactivePromptClassName,
  stripPromptTitlePunctuation
} from "./interactivePromptPresentation";
import { useAskUserAnswerFlow } from "./useAskUserAnswerFlow";

type AskUserPrompt = Extract<AgentConversationPromptVM, { kind: "ask-user" }>;

type SharedAskUserSurfaceProps = Pick<
  AgentInteractivePromptSurfaceProps,
  "edgeGlow" | "isSubmitting" | "labels" | "onSubmit"
> & {
  embedded?: boolean;
  prompt: AskUserPrompt;
};

export function AgentAskUserPromptSurface({
  prompt,
  variant,
  ...props
}: SharedAskUserSurfaceProps & {
  variant: AgentInteractivePromptVariant;
}): JSX.Element {
  "use memo";
  const question = prompt.questions[0] ?? null;
  const useCompactQuickAnswer =
    variant === "compact" &&
    prompt.questions.length === 1 &&
    question !== null &&
    !question.multiSelect &&
    question.options.length > 0;

  if (useCompactQuickAnswer) {
    return (
      <CompactQuickAnswerSurface
        {...props}
        prompt={prompt}
        question={question}
      />
    );
  }

  return (
    <AskUserAnswerFlowSurface
      key={prompt.requestId}
      {...props}
      prompt={prompt}
    />
  );
}

function CompactQuickAnswerSurface({
  prompt,
  question,
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit
}: Omit<SharedAskUserSurfaceProps, "labels"> & {
  question: AskUserPrompt["questions"][number];
}): JSX.Element {
  return (
    <section className={interactivePromptClassName(embedded)}>
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptHeader}>
          <span className={styles.interactivePromptLead}>
            {stripPromptTitlePunctuation(question.header)}
          </span>
        </div>
        <div className={styles.interactivePromptQuestion}>
          {question.question}
        </div>
        <div className={styles.interactivePromptOptions}>
          {question.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className={styles.interactiveOptionButton}
              aria-label={interactiveOptionLabel(
                option.label,
                option.description
              )}
              disabled={isSubmitting}
              onClick={() =>
                onSubmit({
                  requestId: prompt.requestId,
                  action: "submit",
                  payload: {
                    ...buildAskUserAnswerPayload({
                      [question.id]: option.label
                    })
                  }
                })
              }
            >
              <span className={styles.interactiveOptionTitle}>
                {option.label}
              </span>
              {option.description ? (
                <span className={styles.interactiveOptionDescription}>
                  {option.description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function AskUserAnswerFlowSurface({
  prompt,
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit,
  labels
}: SharedAskUserSurfaceProps): JSX.Element {
  "use memo";
  const flow = useAskUserAnswerFlow({
    isSubmitting,
    questions: prompt.questions
  });
  const question = flow.currentQuestion;

  if (!question) {
    return (
      <section className={interactivePromptClassName(embedded)}>
        <div className={interactivePromptCardClassName(edgeGlow)}>
          <div
            className={`${styles.interactivePromptLead} inline-flex items-center gap-1.5`}
          >
            <MessageSquareMoreIcon
              size={15}
              active
              aria-hidden="true"
              className="shrink-0"
            />
            {stripPromptTitlePunctuation(labels.waitingForAnswer)}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={interactivePromptClassName(embedded)}>
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptHeader}>
          <span className={styles.interactivePromptLead}>
            {stripPromptTitlePunctuation(question.header)}
          </span>
          <span className={styles.interactivePromptMeta}>
            {flow.currentIndex + 1}/{prompt.questions.length}
          </span>
        </div>
        <div className={styles.interactivePromptQuestion}>
          {question.question}
        </div>
        {question.options.length > 0 ? (
          <div className={styles.interactivePromptOptions}>
            {question.options.map((option) => {
              const active = flow.selectedOptions.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  className={styles.interactiveOptionButton}
                  data-active={active}
                  aria-pressed={active}
                  aria-label={interactiveOptionLabel(
                    option.label,
                    option.description
                  )}
                  disabled={isSubmitting}
                  onClick={() => flow.toggleOption(option.label)}
                >
                  <span className={styles.interactiveOptionTitle}>
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className={styles.interactiveOptionDescription}>
                      {option.description}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <textarea
          value={flow.freeText}
          placeholder={labels.answerPlaceholder}
          disabled={isSubmitting}
          className={styles.interactivePromptTextarea}
          onChange={(event) => flow.setFreeText(event.currentTarget.value)}
        />
        <div className={styles.interactivePromptActions}>
          {prompt.questions.length > 1 ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isSubmitting || flow.currentIndex === 0}
              onClick={flow.goToPreviousQuestion}
            >
              {labels.previousQuestion}
            </Button>
          ) : null}
          {flow.isLastQuestion ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={isSubmitting || !flow.allQuestionsAnswered}
              onClick={() =>
                onSubmit({
                  requestId: prompt.requestId,
                  action: "submit",
                  payload: { ...flow.answerPayload }
                })
              }
            >
              {labels.submitAnswers}
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={isSubmitting || !flow.currentQuestionAnswered}
              onClick={flow.goToNextQuestion}
            >
              {labels.nextQuestion}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
