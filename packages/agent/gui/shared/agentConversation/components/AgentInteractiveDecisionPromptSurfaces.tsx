import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ShortcutBadge } from "@tutti-os/ui-system";
import {
  getOptionalAgentHostApi,
  useOptionalAgentHostApi
} from "../../../agentActivityHost";
import {
  approvalOptionDisplayLabel,
  approvalOptionVisualPresentation
} from "../approvalOptionPresentation";
import type { AgentConversationPromptVM } from "../contracts/agentConversationVM";
import {
  PLAN_IMPLEMENTATION_ACTION_FEEDBACK,
  PLAN_IMPLEMENTATION_ACTION_IMPLEMENT,
  PLAN_IMPLEMENTATION_ACTION_SKIP
} from "../planImplementationPresentation";
import type { AgentInteractivePromptSurfaceProps } from "./AgentInteractivePromptSurface";
import {
  approvalFeedbackOptionId,
  approvalOptionShortcutLabel,
  CommandTextWithTooltip,
  formatApprovalToolPresentation,
  InteractiveOptionSpinner,
  interactiveOptionLabel,
  interactivePromptCardClassName,
  interactivePromptClassName,
  isDenyApprovalOptionToken,
  isDarwinPlatform,
  isEditableKeyboardTarget,
  isEnterLikeKey,
  PromptDetailValue,
  SendFilledIcon,
  stripPromptTitlePunctuation
} from "./interactivePromptPresentation";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

export function ApprovalPromptSurface({
  prompt,
  embedded = false,
  edgeGlow = false,
  keyboardShortcuts = true,
  isSubmitting,
  onSubmit,
  labels
}: AgentInteractivePromptSurfaceProps & {
  prompt: Extract<AgentConversationPromptVM, { kind: "approval" }>;
  embedded?: boolean;
}) {
  "use memo";
  const promptToolPresentation = useMemo(
    () => formatApprovalToolPresentation(prompt, labels),
    [labels, prompt]
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
  const approveOptionId = useMemo(
    () =>
      prompt.options.find(
        (option) =>
          option.id !== feedbackOptionId &&
          !isDenyApprovalOptionToken(option.id) &&
          !isDenyApprovalOptionToken(option.kind)
      )?.id ?? null,
    [feedbackOptionId, prompt.options]
  );
  const denyOptionId = useMemo(
    () =>
      prompt.options.find(
        (option) =>
          option.id !== feedbackOptionId &&
          (isDenyApprovalOptionToken(option.id) ||
            isDenyApprovalOptionToken(option.kind))
      )?.id ?? null,
    [feedbackOptionId, prompt.options]
  );

  useEffect(() => {
    setSubmittingOptionId(null);
    setPendingFeedbackOptionId(null);
    setFeedback("");
  }, [prompt.requestId]);

  useEffect(() => {
    if (!isSubmitting) {
      setSubmittingOptionId(null);
    }
  }, [isSubmitting]);

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
    <section
      className={interactivePromptClassName(embedded)}
      data-agent-interaction-id={prompt.requestId}
      data-agent-interaction-kind="approval"
      data-testid={`agent-interaction-${prompt.requestId}`}
    >
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptLeadContent}>
          <div className={styles.interactivePromptLead}>
            {stripPromptTitlePunctuation(promptToolPresentation.lead)}
          </div>
          {promptToolPresentation.leadDetails.map((detail) => (
            <div
              key={`${detail.kind}:${detail.value}`}
              className={styles.interactivePromptQuestion}
            >
              {detail.value}
              {detail.meta ? ` ${detail.meta}` : null}
            </div>
          ))}
        </div>
        {promptToolPresentation.cardDetails.length > 0 ? (
          <div className={styles.interactivePromptOptions}>
            {promptToolPresentation.cardDetails.map((detail) => (
              <div
                key={`${detail.label}:${detail.value}`}
                className={styles.interactiveOptionDisplay}
              >
                <span className={styles.interactiveOptionTitle}>
                  {detail.label}
                </span>
                <PromptDetailValue detail={detail} />
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
            const action = approvalActionTestId(
              option.id,
              approveOptionId,
              denyOptionId,
              feedbackOptionId
            );
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
                    data-testid={`agent-approval-${prompt.requestId}-${action}-input`}
                    onChange={(event) => setFeedback(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "Enter" ||
                        event.shiftKey ||
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
                    data-testid={`agent-approval-${prompt.requestId}-${action}-submit`}
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
                data-agent-approval-action={action}
                data-agent-approval-option-id={option.id}
                data-testid={`agent-approval-${prompt.requestId}-${action}`}
                disabled={isSubmitting || submittingOptionId !== null}
                onClick={() => submitOption(option.id)}
              >
                <span className={styles.interactiveOptionContent}>
                  <span className={styles.interactiveOptionTitle}>
                    {optionPresentation.label}
                  </span>
                  {optionPresentation.commandPrefix ? (
                    <CommandTextWithTooltip
                      value={optionPresentation.commandPrefix}
                      testId="agent-interactive-command-prefix-option"
                      tooltipsEnabled
                    />
                  ) : null}
                  {option.description ? (
                    <span className={styles.interactiveOptionDescription}>
                      {option.description}
                    </span>
                  ) : null}
                </span>
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

function approvalActionTestId(
  optionID: string,
  approveOptionID: string | null,
  denyOptionID: string | null,
  feedbackOptionID: string | null
): string {
  if (optionID === feedbackOptionID) return "feedback";
  if (optionID === denyOptionID) return "deny";
  if (optionID === approveOptionID) return "approve";
  return `option-${optionID}`;
}

export function ExitPlanPromptSurface({
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
  // Render the permission modes the runtime actually offered ("Yes, and ...")
  // so newly added modes (e.g. "auto") appear automatically. Localized
  // label/description are looked up by option id, falling back to the runtime's
  // own label for ids we don't have copy for. Only when the runtime sent no
  // options (Codex plan / legacy exitplanmode) do we use the curated defaults.
  const modes =
    prompt.options.length > 0
      ? prompt.options.map((option) => {
          const known = labels.planModes.find((mode) => mode.id === option.id);
          return {
            id: option.id,
            label: known?.label ?? option.label,
            description: known?.description ?? option.description ?? ""
          };
        })
      : labels.planModes;

  useEffect(() => {
    setSubmittingOptionId(null);
  }, [prompt.requestId]);

  useEffect(() => {
    if (!isSubmitting) {
      setSubmittingOptionId(null);
    }
  }, [isSubmitting]);

  return (
    <section
      className={interactivePromptClassName(embedded)}
      data-agent-interaction-id={prompt.requestId}
      data-agent-interaction-kind="exit-plan"
      data-testid={`agent-exit-plan-${prompt.requestId}`}
    >
      <div className={interactivePromptCardClassName(edgeGlow)}>
        <div className={styles.interactivePromptLead}>
          {stripPromptTitlePunctuation(labels.planLead)}
        </div>
        <div className={styles.interactivePromptOptions}>
          {modes.map((mode) => {
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
                data-testid={`agent-exit-plan-confirm-${mode.id}`}
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
                <span className={styles.interactiveOptionContent}>
                  <span className={styles.interactiveOptionTitle}>
                    {mode.label}
                  </span>
                  <span className={styles.interactiveOptionDescription}>
                    {mode.description}
                  </span>
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
              data-testid="agent-exit-plan-feedback"
              onChange={(event) => setFeedback(event.currentTarget.value)}
            />
            <div className={styles.interactivePromptActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isSubmitting}
                data-testid="agent-exit-plan-keep-planning"
                onClick={() =>
                  onSubmit({
                    requestId: prompt.requestId,
                    // The runtime models exit-plan as an approval that requires
                    // an option id, so "keep planning" submits its `plan` option
                    // id (when present) rather than a bare deny. `action: deny`
                    // is kept so the controller doesn't flip plan mode off.
                    action: "deny",
                    ...(prompt.keepPlanningOptionId
                      ? { optionId: prompt.keepPlanningOptionId }
                      : {}),
                    payload: trimmed ? { denyMessage: trimmed } : undefined
                  })
                }
              >
                {continueLabel}
              </Button>
            </div>
          </div>
        ) : (
          // Compact (deck): no textarea, but keep declining reachable — the deck
          // must still let the user keep planning (refining/feedback is deferred
          // to the conversation via the card's "open conversation" jump).
          <div className={styles.interactivePromptActions}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isSubmitting}
              data-testid="agent-exit-plan-keep-planning"
              onClick={() =>
                onSubmit({
                  requestId: prompt.requestId,
                  action: "deny",
                  ...(prompt.keepPlanningOptionId
                    ? { optionId: prompt.keepPlanningOptionId }
                    : {})
                })
              }
            >
              {labels.stayInPlan}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

// Codex plan-mode "implement this plan?" decision. No server request; actions
// are routed by the consumer (controller inline, desktop chrome in the message
// center) keyed on the action id rather than a server submitInteractive.
export function PlanImplementationSurface({
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
            <span className={styles.interactiveOptionContent}>
              <span className={styles.interactiveOptionTitle}>
                {labels.planImplementationConfirm}
              </span>
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
              <Button
                type="button"
                variant="secondary"
                size="sm"
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
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
