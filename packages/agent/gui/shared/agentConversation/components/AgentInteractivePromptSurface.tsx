import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";
import { MessageSquareMoreIcon } from "../../../app/renderer/components/icons/MessageSquareMoreIcon";
import { Spinner } from "../../../app/renderer/components/ui/spinner";
import { translate } from "../../../i18n/index";
import {
  ShortcutBadge,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@tutti-os/ui-system";
import {
  getOptionalAgentHostApi,
  useOptionalAgentHostApi
} from "../../../agentActivityHost";
import {
  approvalOptionDisplayLabel,
  approvalOptionVisualPresentation,
  normalizeApprovalOptionToken
} from "../approvalOptionPresentation";
import type { AgentConversationPromptVM } from "../contracts/agentConversationVM";
import { buildAskUserAnswerPayload } from "../interactiveAnswerPayload";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "../planImplementation";
import {
  getPromptToolDetails,
  type PromptToolDetail
} from "../promptToolDetails";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

const COMMAND_TOOLTIP_DELAY_MS = 1000;

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

interface AgentInteractivePromptSurfaceProps {
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
// conversation" jump), showing just the question for context.
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
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function ApprovalPromptSurface({
  prompt,
  embedded = false,
  edgeGlow = false,
  keyboardShortcuts = true,
  previewMode = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "approval" }>;
  embedded?: boolean;
}) {
  "use memo";
  const promptDetails = useMemo(
    () => formatToolDetails(prompt.input ?? null),
    [prompt.input]
  );
  const [submittingOptionId, setSubmittingOptionId] = useState<string | null>(
    null
  );
  const [pendingFeedbackOptionId, setPendingFeedbackOptionId] = useState<
    string | null
  >(null);
  const [feedback, setFeedback] = useState("");
  const feedbackTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const agentHostApi = useOptionalAgentHostApi() ?? getOptionalAgentHostApi();
  const isDarwin = isDarwinPlatform(agentHostApi?.meta?.platform);
  const feedbackOptionId = useMemo(
    () => approvalFeedbackOptionId(prompt.options),
    [prompt.options]
  );
  const feedbackValue = feedback.trim();

  useEffect(() => {
    setSubmittingOptionId(null);
    setPendingFeedbackOptionId(null);
    setFeedback("");
  }, [prompt.requestId]);

  useEffect(() => {
    if (pendingFeedbackOptionId !== null) {
      feedbackTextareaRef.current?.focus();
    }
  }, [pendingFeedbackOptionId]);

  const submitOption = useCallback(
    (optionId: string) => {
      const feedbackOption = feedbackOptionId === optionId;
      if (feedbackOption && pendingFeedbackOptionId !== optionId) {
        setFeedback("");
        setPendingFeedbackOptionId(optionId);
        return;
      }
      setSubmittingOptionId(optionId);
      onSubmit({
        requestId: prompt.requestId,
        ...(feedbackOption ? { action: "deny" } : {}),
        optionId,
        ...(feedbackOption && feedbackValue
          ? { payload: { denyMessage: feedbackValue } }
          : {})
      });
    },
    [
      feedbackOptionId,
      feedbackValue,
      onSubmit,
      pendingFeedbackOptionId,
      prompt.requestId
    ]
  );

  useEffect(() => {
    if (
      !keyboardShortcuts ||
      isSubmitting ||
      submittingOptionId !== null ||
      prompt.options.length === 0
    ) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        !isEnterLikeKey(event) ||
        isEditableKeyboardTarget(event.target) ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const optionIndex = event.metaKey || event.ctrlKey ? 1 : 0;
      const option = prompt.options[optionIndex];
      if (!option) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      submitOption(option.id);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isSubmitting,
    keyboardShortcuts,
    prompt.options,
    submitOption,
    submittingOptionId
  ]);

  return (
    <section className={interactivePromptClassName(embedded)}>
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptLead}>
          {stripPromptTitlePunctuation(labels.approvalLead)}
        </div>
        {promptDetails.length > 0 ? (
          <div className={styles.interactivePromptOptions}>
            {promptDetails.map((detail) => (
              <div
                key={`${detail.label}:${detail.value}`}
                className={styles.interactiveOptionDisplay}
              >
                <span className={styles.interactiveOptionTitle}>
                  {detail.label}
                </span>
                <PromptDetailValue detail={detail} previewMode={previewMode} />
                {detail.meta ? (
                  <span className={styles.interactiveOptionDescription}>
                    {detail.meta}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className={styles.interactivePromptOptions}>
          {prompt.options.map((option, optionIndex) => {
            const showSpinner = submittingOptionId === option.id;
            const optionSupportsFeedback = feedbackOptionId === option.id;
            const optionLabel = approvalOptionDisplayLabel(option, {
              feedback: optionSupportsFeedback
            });
            const optionPresentation = approvalOptionVisualPresentation(
              option,
              { feedback: optionSupportsFeedback }
            );
            const shortcutLabel = approvalOptionShortcutLabel(
              optionIndex,
              isDarwin
            );
            const showFeedbackComposer = pendingFeedbackOptionId === option.id;
            if (showFeedbackComposer) {
              return (
                <div
                  key={option.id}
                  className={styles.interactiveFeedbackComposer}
                >
                  <textarea
                    ref={feedbackTextareaRef}
                    value={feedback}
                    placeholder={labels.feedbackPlaceholder}
                    disabled={isSubmitting || submittingOptionId !== null}
                    className={styles.interactivePromptTextarea}
                    aria-label={interactiveOptionLabel(
                      optionLabel,
                      option.description
                    )}
                    onChange={(event) => setFeedback(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (
                        !keyboardShortcuts ||
                        event.key !== "Enter" ||
                        (!event.metaKey && !event.ctrlKey) ||
                        event.nativeEvent.isComposing
                      ) {
                        return;
                      }
                      event.preventDefault();
                      if (!feedbackValue) {
                        feedbackTextareaRef.current?.focus();
                        return;
                      }
                      submitOption(option.id);
                    }}
                  />
                  <button
                    type="button"
                    className={styles.interactiveFeedbackSendButton}
                    disabled={
                      isSubmitting ||
                      submittingOptionId !== null ||
                      !feedbackValue
                    }
                    aria-label={labels.sendFeedback}
                    title={labels.sendFeedback}
                    aria-busy={showSpinner}
                    onClick={() => {
                      if (!feedbackValue) {
                        feedbackTextareaRef.current?.focus();
                        return;
                      }
                      submitOption(option.id);
                    }}
                  >
                    {showSpinner ? (
                      <InteractiveOptionSpinner />
                    ) : (
                      <SendFilledIcon />
                    )}
                  </button>
                </div>
              );
            }
            return (
              <button
                key={option.id}
                type="button"
                className={styles.interactiveOptionButton}
                aria-label={interactiveOptionLabel(
                  optionLabel,
                  option.description
                )}
                disabled={isSubmitting || submittingOptionId !== null}
                onClick={() => submitOption(option.id)}
              >
                <span className={styles.interactiveOptionTitle}>
                  {optionPresentation.label}
                </span>
                {optionPresentation.commandPrefix ? (
                  <CommandTextWithTooltip
                    value={optionPresentation.commandPrefix}
                    testId="agent-interactive-command-prefix-option"
                    tooltipsEnabled={!previewMode}
                  />
                ) : null}
                {option.description ? (
                  <span className={styles.interactiveOptionDescription}>
                    {option.description}
                  </span>
                ) : null}
                {keyboardShortcuts && shortcutLabel && !showSpinner ? (
                  <ShortcutBadge
                    className={styles.interactiveOptionShortcut}
                    aria-hidden="true"
                  >
                    {shortcutLabel}
                  </ShortcutBadge>
                ) : null}
                {showSpinner ? <InteractiveOptionSpinner /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ExitPlanPromptSurface({
  prompt,
  variant = "full",
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "exit-plan" }>;
  embedded?: boolean;
}) {
  "use memo";
  const [feedback, setFeedback] = useState("");
  // Compact (message-center deck): only the permission-mode decision buttons are
  // offered; refining / staying in plan is deferred to the conversation.
  const showFeedbackFooter = variant !== "compact";
  const [submittingOptionId, setSubmittingOptionId] = useState<string | null>(
    null
  );
  const trimmed = feedback.trim();
  const continueLabel =
    trimmed === "" ? labels.stayInPlan : labels.sendFeedback;

  useEffect(() => {
    setSubmittingOptionId(null);
  }, [prompt.requestId]);

  return (
    <section className={interactivePromptClassName(embedded)}>
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptLead}>
          {stripPromptTitlePunctuation(labels.planLead)}
        </div>
        <div className={styles.interactivePromptOptions}>
          {labels.planModes.map((mode) => {
            const showSpinner = submittingOptionId === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={styles.interactiveOptionButton}
                aria-label={interactiveOptionLabel(
                  mode.label,
                  mode.description
                )}
                disabled={isSubmitting || submittingOptionId !== null}
                onClick={() => {
                  setSubmittingOptionId(mode.id);
                  onSubmit({
                    requestId: prompt.requestId,
                    action: "allow",
                    optionId: mode.id
                  });
                }}
              >
                <span className={styles.interactiveOptionTitle}>
                  {mode.label}
                </span>
                <span className={styles.interactiveOptionDescription}>
                  {mode.description}
                </span>
                {showSpinner ? <InteractiveOptionSpinner /> : null}
              </button>
            );
          })}
        </div>
        {showFeedbackFooter ? (
          <div className={styles.interactivePromptFooter}>
            <textarea
              value={feedback}
              placeholder={labels.feedbackPlaceholder}
              disabled={isSubmitting}
              className={styles.interactivePromptTextarea}
              onChange={(event) => setFeedback(event.currentTarget.value)}
            />
            <div className={styles.interactivePromptActions}>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() =>
                  onSubmit({
                    requestId: prompt.requestId,
                    action: "deny",
                    payload: trimmed ? { denyMessage: trimmed } : undefined
                  })
                }
              >
                {continueLabel}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Codex plan-mode "implement this plan?" decision. No server request; actions
// are routed by the consumer (controller inline, desktop chrome in the message
// center) keyed on the action id rather than a server submitInteractive.
function PlanImplementationSurface({
  prompt,
  variant = "full",
  embedded = false,
  edgeGlow = false,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "plan-implementation" }>;
  embedded?: boolean;
}) {
  "use memo";
  const [feedback, setFeedback] = useState("");
  const trimmed = feedback.trim();
  const continueLabel =
    trimmed === ""
      ? labels.planImplementationSkip
      : labels.planImplementationSend;
  // Compact (message-center deck): only the "implement" decision is offered.
  // Refining or staying in plan mode is deferred to the conversation, reachable
  // via the card's "open conversation" jump.
  const showFeedbackFooter = variant !== "compact";

  return (
    <section className={interactivePromptClassName(embedded)}>
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptLead}>
          {stripPromptTitlePunctuation(labels.planImplementationLead)}
        </div>
        <div className={styles.interactivePromptOptions}>
          <button
            type="button"
            className={styles.interactiveOptionButton}
            data-testid="agent-plan-implementation-implement"
            disabled={isSubmitting}
            onClick={() =>
              onSubmit({
                requestId: prompt.requestId,
                action: PLAN_IMPLEMENTATION_ACTION_IMPLEMENT
              })
            }
          >
            <span className={styles.interactiveOptionTitle}>
              {labels.planImplementationConfirm}
            </span>
          </button>
        </div>
        {showFeedbackFooter ? (
          <div className={styles.interactivePromptFooter}>
            <textarea
              value={feedback}
              placeholder={labels.planImplementationFeedbackPlaceholder}
              disabled={isSubmitting}
              className={styles.interactivePromptTextarea}
              data-testid="agent-plan-implementation-feedback"
              onChange={(event) => setFeedback(event.currentTarget.value)}
            />
            <div className={styles.interactivePromptActions}>
              <button
                type="button"
                data-testid="agent-plan-implementation-continue"
                disabled={isSubmitting}
                onClick={() =>
                  onSubmit({
                    requestId: prompt.requestId,
                    action:
                      trimmed === ""
                        ? PLAN_IMPLEMENTATION_ACTION_SKIP
                        : PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
                    payload: trimmed ? { text: trimmed } : undefined
                  })
                }
              >
                {continueLabel}
              </button>
            </div>
          </div>
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
          <button
            type="button"
            disabled={isSubmitting || index === 0}
            onClick={() => setIndex((current) => Math.max(current - 1, 0))}
          >
            {labels.previousQuestion}
          </button>
          {isLast ? (
            <button
              type="button"
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
            </button>
          ) : (
            <button
              type="button"
              disabled={isSubmitting || !canAdvance}
              onClick={() =>
                setIndex((current) =>
                  Math.min(current + 1, prompt.questions.length - 1)
                )
              }
            >
              {labels.nextQuestion}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function isEnterLikeKey(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" ||
    event.code === "Enter" ||
    event.code === "NumpadEnter"
  );
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

function approvalOptionShortcutLabel(
  optionIndex: number,
  isDarwin: boolean
): string | null {
  if (optionIndex === 0) {
    return translate("agentHost.agentGui.shortcutEnter");
  }
  if (optionIndex === 1) {
    return isDarwin
      ? translate("agentHost.agentGui.shortcutCmdEnter")
      : translate("agentHost.agentGui.shortcutCtrEnter");
  }
  return null;
}

function isDarwinPlatform(platform: string | undefined): boolean {
  if (platform) {
    return platform === "darwin";
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgentPlatform =
    "userAgentData" in navigator
      ? (
          navigator as Navigator & {
            userAgentData?: { platform?: string };
          }
        ).userAgentData?.platform
      : undefined;
  const navigatorPlatform = userAgentPlatform ?? navigator.platform ?? "";
  return /mac/i.test(navigatorPlatform);
}

function InteractiveOptionSpinner(): JSX.Element {
  "use memo";
  return (
    <Spinner
      className={styles.interactiveOptionSpinner}
      testId="agent-interactive-option-spinner"
    />
  );
}

function SendFilledIcon(): JSX.Element {
  "use memo";
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.74311 8.80587C2.84592 8.40096 3.14571 8.08844 3.54551 7.97033L18.5197 3.51569C18.9336 3.39383 19.3809 3.5054 19.6881 3.81262C19.9951 4.11984 20.1076 4.56798 19.9857 4.9817L15.5311 19.9559C15.413 20.3557 15.1005 20.6555 14.6956 20.7583C14.2895 20.8597 13.869 20.7438 13.5721 20.4469L10.455 15.1823C10.8585 14.6483 12.1563 12.9094 14.3475 9.96528C14.6086 9.70419 14.6382 9.31168 14.4138 9.08692C14.1891 8.86221 13.796 8.8913 13.5348 9.15252L8.31088 13.0423L3.05316 9.92799C2.7562 9.63104 2.64049 9.21071 2.74311 8.80587Z"
        fill="currentColor"
      />
    </svg>
  );
}

function interactivePromptClassName(embedded: boolean): string {
  return embedded
    ? `${styles.interactivePrompt} agent-gui-conversation__interactive-prompt--embedded`
    : styles.interactivePrompt;
}

function interactivePromptCardClassName(edgeGlow: boolean): string {
  return edgeGlow
    ? `${styles.interactivePromptCard} agent-gui-edge-glow`
    : styles.interactivePromptCard;
}

interface LabeledPromptToolDetail {
  kind: PromptToolDetail["kind"];
  label: string;
  value: string;
  meta?: string;
}

function formatToolDetails(
  input: Record<string, unknown> | null
): LabeledPromptToolDetail[] {
  return getPromptToolDetails(input).map((detail) => ({
    kind: detail.kind,
    label: promptToolDetailLabel(detail.kind),
    value: detail.value,
    ...(detail.meta ? { meta: detail.meta } : {})
  }));
}

function PromptDetailValue({
  detail,
  previewMode
}: {
  detail: LabeledPromptToolDetail;
  previewMode: boolean;
}): JSX.Element {
  "use memo";
  if (detail.kind !== "command") {
    return (
      <span className={styles.interactiveOptionDescription}>
        {detail.value}
      </span>
    );
  }
  return (
    <CommandTextWithTooltip
      value={detail.value}
      testId="agent-interactive-command-detail"
      tooltipsEnabled={!previewMode}
    />
  );
}

function CommandTextWithTooltip({
  value,
  testId,
  tooltipsEnabled = true
}: {
  value: string;
  testId: string;
  tooltipsEnabled?: boolean;
}): JSX.Element {
  "use memo";
  const content = (
    <span
      className={`${styles.interactiveOptionDescription} ${styles.interactiveOptionCommandDescription}`}
      data-agent-interactive-command-detail={
        testId === "agent-interactive-command-detail" ? "true" : undefined
      }
      data-agent-interactive-command-prefix-option={
        testId === "agent-interactive-command-prefix-option"
          ? "true"
          : undefined
      }
    >
      {value}
    </span>
  );

  if (!tooltipsEnabled) {
    return content;
  }

  return (
    <TooltipProvider delayDuration={COMMAND_TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent className={styles.interactiveOptionCommandTooltip}>
          {value}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function promptToolDetailLabel(kind: PromptToolDetail["kind"]): string {
  switch (kind) {
    case "command":
      return translate("agentHost.agentTool.details.command");
    case "mcp":
      return translate("agentHost.agentTool.details.mcp");
    case "path":
      return translate("agentHost.agentTool.details.path");
    case "query":
      return translate("agentHost.agentTool.details.query");
  }
}

function isApprovalFeedbackOption(option: {
  id: string;
  kind: string;
}): boolean {
  return (
    isDenyApprovalOptionToken(option.id) ||
    isDenyApprovalOptionToken(option.kind)
  );
}

function approvalFeedbackOptionId(
  options: readonly { id: string; kind: string }[]
): string | null {
  const explicitFeedbackOption = options.find((option) =>
    isExplicitFeedbackDenyApprovalOption(option)
  );
  if (explicitFeedbackOption) {
    return explicitFeedbackOption.id;
  }
  return options.find(isApprovalFeedbackOption)?.id ?? null;
}

function isExplicitFeedbackDenyApprovalOption(option: {
  id: string;
  kind: string;
}): boolean {
  for (const value of [option.id, option.kind]) {
    switch (normalizeApprovalOptionToken(value ?? "")) {
      case "abort":
      case "cancel":
      case "cancelled":
      case "canceled":
      case "denywithfeedback":
      case "rejectwithfeedback":
        return true;
      default:
        break;
    }
  }
  return false;
}

function isDenyApprovalOptionToken(value: string | null | undefined): boolean {
  switch (normalizeApprovalOptionToken(value ?? "")) {
    case "abort":
    case "cancel":
    case "cancelled":
    case "canceled":
    case "deny":
    case "denied":
    case "reject":
    case "rejected":
    case "rejectonce":
    case "disallow":
    case "decline":
    case "declined":
    case "no":
      return true;
    default:
      return false;
  }
}

function stripPromptTitlePunctuation(value: string): string {
  return value.trim().replace(/[.。]+$/u, "");
}

function interactiveOptionLabel(
  label: string,
  description: string | null | undefined
): string {
  const trimmedDescription = description?.trim();
  return trimmedDescription ? `${label} ${trimmedDescription}` : label;
}
