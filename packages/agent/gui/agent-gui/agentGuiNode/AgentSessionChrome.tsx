import { type JSX, type ReactNode } from "react";
import { Button } from "@tutti-os/ui-system";
import { CastIcon } from "../../app/renderer/components/icons/CastIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "../../app/renderer/components/ui/tooltip";
import { cn } from "../../app/renderer/lib/utils";
import { approvalOptionDisplayLabel } from "../../shared/agentConversation/approvalOptionPresentation";
import type { AgentGUISessionChrome } from "./model/agentGuiNodeTypes";
import styles from "./AgentGUIChrome.styles";

interface AgentChromeNoticeProps {
  tone: "warning" | "danger" | "muted";
  title: string;
  description?: string;
  icon?: ReactNode;
  role?: "alert" | "status";
  testId?: string;
}

interface AgentSessionChromeProps {
  chrome: AgentGUISessionChrome;
  isRespondingApproval: boolean;
  onSubmitApprovalOption: (requestId: string, optionId: string) => void;
  onAuthLogin?: () => void;
  onRetryActivation: () => void;
  onContinueInNewConversation: () => void;
  labels: {
    approvalRequired: string;
    authLogin?: string;
    authRequired: string;
    activatingSession: string;
    retryActivation: string;
    continueInNewConversation: string;
  };
}

function splitTrailingEllipsis(message: string): {
  label: string;
  ellipsis: string | null;
} {
  const match = message.match(/^(.*?)(\.{3}|…)\s*$/);
  if (!match) {
    return { label: message, ellipsis: null };
  }

  return {
    label: match[1] ?? message,
    ellipsis: match[2] ?? null
  };
}

function LoadingEllipsis(): JSX.Element {
  "use memo";
  return (
    <span className="tsh-inline-loading-ellipsis" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function ChromeMessageTooltip({
  message,
  children
}: {
  message: string;
  children: ReactNode;
}): JSX.Element {
  "use memo";
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          className={styles.chromeMessageTooltip}
          side="top"
          sideOffset={6}
        >
          {message}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function AgentChromeNotice({
  tone,
  title,
  description,
  icon,
  role,
  testId
}: AgentChromeNoticeProps): JSX.Element {
  "use memo";
  const fullMessage = description ? `${title} ${description}` : title;
  const toneClassName =
    tone === "danger"
      ? styles.chromeCardDanger
      : tone === "muted"
        ? styles.chromeCardMuted
        : styles.chromeCardWarning;
  return (
    <div className={styles.sessionChrome}>
      <section
        className={cn(styles.chromeCard, toneClassName)}
        role={role}
        data-testid={testId}
      >
        <div className={styles.chromeMetaRow}>
          <div className={styles.chromeMessageSlot}>
            {icon ? <span className={styles.chromeIcon}>{icon}</span> : null}
            <p
              className={cn(styles.chromeMessage, styles.chromeNoticeMessage)}
              title={fullMessage}
            >
              <span className={styles.chromeNoticeTitle}>{title}</span>
              {description ? (
                <span className={styles.chromeNoticeDescription}>
                  {description}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

export function AgentSessionChrome({
  chrome,
  isRespondingApproval,
  onSubmitApprovalOption,
  onAuthLogin,
  onRetryActivation,
  onContinueInNewConversation,
  labels
}: AgentSessionChromeProps): JSX.Element | null {
  "use memo";
  const visibleAuth =
    chrome.recovery?.kind === "activating" ? null : chrome.auth;
  const visibleRecovery = chrome.recovery;
  const recoveryMessage =
    visibleRecovery?.kind === "activating"
      ? labels.activatingSession
      : (visibleRecovery?.message ?? "");
  const recoveryHasInlineAction =
    visibleRecovery?.kind === "failed" &&
    (visibleRecovery.followupAction === "continue-in-new-conversation" ||
      visibleRecovery.canRetry !== false);
  const activatingMessage = splitTrailingEllipsis(recoveryMessage);
  const hasContent =
    visibleAuth !== null ||
    chrome.approval !== null ||
    visibleRecovery !== null;

  if (!hasContent) {
    return null;
  }

  return (
    <div className={styles.sessionChrome}>
      {visibleAuth ? (
        <section className={cn(styles.chromeCard, styles.chromeCardWarning)}>
          <div className={styles.chromeMetaRow}>
            <div className={styles.chromeMessageSlot}>
              <ChromeMessageTooltip message={visibleAuth.message}>
                <p className={styles.chromeMessage} tabIndex={0}>
                  {visibleAuth.message}
                </p>
              </ChromeMessageTooltip>
            </div>
            <div className={styles.chromeInlineActions}>
              {onAuthLogin ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onAuthLogin()}
                >
                  {labels.authLogin ?? labels.retryActivation}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRetryActivation()}
              >
                {labels.retryActivation}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {chrome.approval ? (
        <section className={cn(styles.chromeCard, styles.chromeCardAction)}>
          <div className={styles.chromeTitle}>{labels.approvalRequired}</div>
          <p className={styles.chromeMessage}>{chrome.approval.title}</p>
          <div className={styles.chromeActions}>
            {chrome.approval.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={isRespondingApproval}
                onClick={() =>
                  onSubmitApprovalOption(
                    chrome.approval?.requestId ?? "",
                    option.id
                  )
                }
              >
                {approvalOptionDisplayLabel(option)}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {visibleRecovery ? (
        <section
          role={visibleRecovery.kind === "failed" ? "alert" : undefined}
          aria-live={
            visibleRecovery.kind === "failed" ? "assertive" : undefined
          }
          data-has-inline-actions={recoveryHasInlineAction ? "true" : "false"}
          className={cn(
            styles.chromeCard,
            visibleRecovery.kind === "failed"
              ? styles.chromeCardDanger
              : visibleRecovery.kind === "warning"
                ? styles.chromeCardDanger
                : visibleRecovery.kind === "activating"
                  ? styles.chromeCardConnecting
                  : styles.chromeCardMuted
          )}
        >
          <div className={styles.chromeMetaRow}>
            <div className={styles.chromeMessageSlot}>
              {visibleRecovery.kind === "activating" ? (
                <CastIcon
                  active
                  aria-hidden="true"
                  className={styles.chromeIcon}
                  data-testid="agent-session-chrome-connecting-icon"
                  size={16}
                />
              ) : null}
              <ChromeMessageTooltip message={recoveryMessage}>
                <p
                  className={styles.chromeMessage}
                  aria-label={
                    visibleRecovery.kind === "activating"
                      ? recoveryMessage
                      : undefined
                  }
                  tabIndex={0}
                >
                  {visibleRecovery.kind === "activating" ? (
                    <>
                      <span className="tsh-inline-loading-label">
                        {activatingMessage.label}
                      </span>
                      {activatingMessage.ellipsis ? <LoadingEllipsis /> : null}
                    </>
                  ) : (
                    recoveryMessage
                  )}
                </p>
              </ChromeMessageTooltip>
            </div>
            <div className={styles.chromeInlineActions}>
              {visibleRecovery.kind === "failed" &&
              visibleRecovery.followupAction ===
                "continue-in-new-conversation" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.chromeDangerGhostButton}
                  onClick={() => onContinueInNewConversation()}
                >
                  {labels.continueInNewConversation}
                </Button>
              ) : visibleRecovery.kind === "failed" &&
                visibleRecovery.canRetry !== false ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.chromeDangerGhostButton}
                  onClick={() => onRetryActivation()}
                >
                  {labels.retryActivation}
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
