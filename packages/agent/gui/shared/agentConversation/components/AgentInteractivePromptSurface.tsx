import { useMemo, useState, type JSX } from "react";
import { MessageSquareMoreIcon } from "../../../app/renderer/components/icons/MessageSquareMoreIcon";
import { Button } from "@tutti-os/ui-system";
import type { AgentConversationPromptVM } from "../contracts/agentConversationVM";
import { buildAskUserAnswerPayload } from "../interactiveAnswerPayload";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";
import {
  ApprovalPromptSurface,
  ExitPlanPromptSurface,
  PlanImplementationSurface
} from "./AgentInteractiveDecisionPromptSurfaces";
import {
  interactiveOptionLabel,
  interactivePromptCardClassName,
  interactivePromptClassName,
  stripPromptTitlePunctuation
} from "./interactivePromptPresentation";

/**
 * Where the prompt is rendered, which sets its interaction budget:
 * - "full" (conversation / composer): the user is focused here, so every action
 *   is shown — primary decisions plus rich follow-ups (feedback textareas,
 *   multi-step wizards, "stay in plan").
 * - "compact" (message-center attention deck): a glanceable needs-attention card
 *   across many sessions. Only the primary decision is shown; rich follow-up
 *   input is deferred to the conversation, reachable via the card's "open
 *   conversation" jump. New prompt kinds must consciously choose their compact
 *   form here instead of silently inheriting the full conversation surface.
 */
export type AgentInteractivePromptVariant = "full" | "compact";

export interface AgentInteractivePromptSurfaceProps {
  prompt: AgentConversationPromptVM;
  variant?: AgentInteractivePromptVariant;
  edgeGlow?: boolean;
  keyboardShortcuts?: boolean;
  previewMode?: boolean;
  isSubmitting: boolean;
  onSubmit: (input: {
    requestId: string;
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }) => void;
  labels: {
    approvalLead: string;
    planLead: string;
    planModes: Array<{ id: string; label: string; description: string }>;
    stayInPlan: string;
    sendFeedback: string;
    feedbackPlaceholder: string;
    previousQuestion: string;
    nextQuestion: string;
    submitAnswers: string;
    answerPlaceholder: string;
    waitingForAnswer: string;
    planImplementationLead: string;
    planImplementationConfirm: string;
    planImplementationFeedbackPlaceholder: string;
    planImplementationSend: string;
    planImplementationSkip: string;
  };
}

export function AgentInteractivePromptSurface({
  prompt,
  variant = "full",
  edgeGlow = false,
  embedded = false,
  keyboardShortcuts = true,
  previewMode = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  embedded?: boolean;
}): JSX.Element | null {
  "use memo";

  if (prompt.kind === "approval") {
    return (
      <ApprovalPromptSurface
        prompt={prompt}
        embedded={embedded}
        edgeGlow={edgeGlow}
        keyboardShortcuts={keyboardShortcuts}
        previewMode={previewMode}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  if (prompt.kind === "exit-plan") {
    return (
      <ExitPlanPromptSurface
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        previewMode={previewMode}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  if (prompt.kind === "plan-implementation") {
    return (
      <PlanImplementationSurface
        prompt={prompt}
        variant={variant}
        embedded={embedded}
        edgeGlow={edgeGlow}
        previewMode={previewMode}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  return (
    <AskUserPromptSurface
      prompt={prompt}
      variant={variant}
      embedded={embedded}
      edgeGlow={edgeGlow}
      previewMode={previewMode}
      isSubmitting={isSubmitting}
      onSubmit={onSubmit}
      labels={labels}
    />
  );
}

// Compact (message-center deck): a single-select question is answered with one
// click — selecting an option submits it immediately, matching the approval and
// plan cards. Multi-select / multi-question / free-text-only prompts can't be
// answered in one tap, so they defer to the conversation (the card's "open
// conversation" jump); their options are still shown as read-only context
// (see the non-oneClickable branch below) rather than being omitted.
function CompactAskUserPromptSurface({
  prompt,
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "ask-user" }>;
  embedded?: boolean;
}) {
  "use memo";
  const question = prompt.questions[0] ?? null;
  const oneClickable =
    prompt.questions.length === 1 &&
    question !== null &&
    !question.multiSelect &&
    question.options.length > 0;

  return (
    <section className={interactivePromptClassName(embedded)}>
      <div className={interactivePromptCardClassName(edgeGlow)}>
        {question ? (
          <>
            <div className={styles.interactivePromptHeader}>
              <span className={styles.interactivePromptLead}>
                {stripPromptTitlePunctuation(question.header)}
              </span>
            </div>
            <div className={styles.interactivePromptQuestion}>
              {question.question}
            </div>
            {oneClickable ? (
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
            ) : question.options.length > 0 ? (
              // Multi-select / multi-question prompts can't be answered with a
              // single click here, so the options are shown as read-only
              // context instead of being silently omitted. Answering still
              // happens in the full conversation via the card's "open
              // conversation" jump.
              <div className={styles.interactivePromptOptions}>
                {question.options.map((option) => (
                  <div
                    key={option.label}
                    className={styles.interactiveOptionDisplay}
                  >
                    <span className={styles.interactiveOptionTitle}>
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className={styles.interactiveOptionDescription}>
                        {option.description}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function AskUserPromptSurface({
  prompt,
  variant = "full",
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "ask-user" }>;
  embedded?: boolean;
}) {
  "use memo";
  if (variant === "compact") {
    return (
      <CompactAskUserPromptSurface
        prompt={prompt}
        embedded={embedded}
        edgeGlow={edgeGlow}
        isSubmitting={isSubmitting}
        onSubmit={onSubmit}
        labels={labels}
      />
    );
  }
  return (
    <FullAskUserPromptSurface
      prompt={prompt}
      embedded={embedded}
      edgeGlow={edgeGlow}
      isSubmitting={isSubmitting}
      onSubmit={onSubmit}
      labels={labels}
    />
  );
}

function FullAskUserPromptSurface({
  prompt,
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "ask-user" }>;
  embedded?: boolean;
}) {
  "use memo";
  const [index, setIndex] = useState(0);
  const [selectedByQuestionId, setSelectedByQuestionId] = useState<
    Record<string, string[]>
  >({});
  const [freeTextByQuestionId, setFreeTextByQuestionId] = useState<
    Record<string, string>
  >({});

  const question = prompt.questions[index] ?? null;
  const selected = question ? (selectedByQuestionId[question.id] ?? []) : [];
  const freeText = question ? (freeTextByQuestionId[question.id] ?? "") : "";
  const canAdvance =
    question !== null &&
    (selected.length > 0 ||
      freeText.trim() !== "" ||
      question.options.length === 0);
  const isLast = index >= prompt.questions.length - 1;

  const payload = useMemo(() => {
    const answersByQuestionId: Record<string, string | string[]> = {};
    for (const current of prompt.questions) {
      const chosen = selectedByQuestionId[current.id] ?? [];
      const other = (freeTextByQuestionId[current.id] ?? "").trim();
      if (current.multiSelect) {
        const value = other ? [...chosen, other] : chosen;
        if (value.length > 0) {
          answersByQuestionId[current.id] = value;
        }
        continue;
      }
      const value = other || chosen[0];
      if (value) {
        answersByQuestionId[current.id] = value;
      }
    }
    return buildAskUserAnswerPayload(answersByQuestionId);
  }, [freeTextByQuestionId, prompt.questions, selectedByQuestionId]);

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
            {index + 1}/{prompt.questions.length}
          </span>
        </div>
        <div className={styles.interactivePromptQuestion}>
          {question.question}
        </div>
        {question.options.length > 0 ? (
          <div className={styles.interactivePromptOptions}>
            {question.options.map((option) => {
              const active = selected.includes(option.label);
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
                  onClick={() => {
                    setSelectedByQuestionId((current) => {
                      const existing = current[question.id] ?? [];
                      const next = question.multiSelect
                        ? existing.includes(option.label)
                          ? existing.filter((value) => value !== option.label)
                          : [...existing, option.label]
                        : existing.includes(option.label)
                          ? []
                          : [option.label];
                      return { ...current, [question.id]: next };
                    });
                  }}
                >
                  <span className={styles.interactiveOptionTitle}>
                    {option.label}
                  </span>
                  <span className={styles.interactiveOptionDescription}>
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <textarea
          value={freeText}
          placeholder={labels.answerPlaceholder}
          disabled={isSubmitting}
          className={styles.interactivePromptTextarea}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFreeTextByQuestionId((current) => ({
              ...current,
              [question.id]: value
            }));
          }}
        />
        <div className={styles.interactivePromptActions}>
          {prompt.questions.length > 1 ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isSubmitting || index === 0}
              onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            >
              {labels.previousQuestion}
            </Button>
          ) : null}
          {isLast ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={
                isSubmitting ||
                Object.keys(payload.answersByQuestionId).length === 0
              }
              onClick={() =>
                onSubmit({
                  requestId: prompt.requestId,
                  action: "submit",
                  payload: { ...payload }
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
              disabled={isSubmitting || !canAdvance}
              onClick={() =>
                setIndex((current) =>
                  Math.min(current + 1, prompt.questions.length - 1)
                )
              }
            >
              {labels.nextQuestion}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
