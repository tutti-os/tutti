import { useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { Badge, StatusDot } from "@tutti-os/ui-system";
import type {
  TerminalCloseGuardResult,
  TerminalHeaderAccessoryRenderer,
  TerminalNodeExternalState,
  TerminalPreviewChangeHandler,
  TerminalSessionStatus
} from "../contracts/index.ts";
import type { TerminalNodeFeature } from "../core/feature.ts";
import { createTerminalCloseDiagnostics } from "../core/sessionDiagnostics.ts";
import { isTerminalSessionEndedStatus } from "../core/index.ts";
import { hasTerminalHeaderDefaultActions } from "./headerActions.ts";
import { TerminalSurface } from "./TerminalSurface.tsx";

export interface TerminalNodeProps {
  children?: ReactNode;
  controllerLeaseRetainedExternally?: boolean;
  externalState?: TerminalNodeExternalState | null;
  feature: TerminalNodeFeature;
  headerAccessory?: TerminalHeaderAccessoryRenderer;
  nodeId: string;
  onFocusRequest?: () => void;
  onPreviewChange?: TerminalPreviewChangeHandler;
  sessionId?: string | null;
  showHeader?: boolean;
}

export interface TerminalNodeHeaderProps extends HTMLAttributes<HTMLElement> {
  className?: string;
  defaultActions?: ReactNode;
  externalState?: TerminalNodeExternalState | null;
  feature: TerminalNodeFeature;
  headerAccessory?: TerminalHeaderAccessoryRenderer;
  onCloseRequest?: () => void;
  sessionId?: string | null;
}

export interface TerminalCloseGuardDialogProps {
  feature: TerminalNodeFeature;
  leaderCommand?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
}

export function TerminalNode({
  children,
  controllerLeaseRetainedExternally = false,
  externalState = null,
  feature,
  headerAccessory,
  nodeId,
  onFocusRequest,
  onPreviewChange,
  sessionId,
  showHeader = true
}: TerminalNodeProps) {
  const resolvedSessionId = sessionId ?? externalState?.sessionId ?? null;
  const status = externalState?.status ?? "created";

  return (
    <section
      className="workspace-terminal"
      data-terminal-node={nodeId}
      data-terminal-session-id={resolvedSessionId ?? undefined}
      onClick={onFocusRequest}
    >
      {showHeader ? (
        <TerminalNodeHeader
          externalState={externalState}
          feature={feature}
          headerAccessory={headerAccessory}
          sessionId={resolvedSessionId}
        />
      ) : null}
      <div className="workspace-terminal__body">
        {children ??
          (resolvedSessionId ? (
            <TerminalSurface
              controllerLeaseRetainedExternally={
                controllerLeaseRetainedExternally
              }
              externalState={externalState}
              feature={feature}
              nodeId={nodeId}
              onPreviewChange={onPreviewChange}
              sessionId={resolvedSessionId}
              status={status}
            />
          ) : (
            <div className="workspace-terminal__placeholder">
              {feature.i18n.t("emptySession")}
            </div>
          ))}
      </div>
    </section>
  );
}

export function TerminalNodeHeader({
  className,
  defaultActions,
  externalState = null,
  feature,
  headerAccessory,
  onCloseRequest,
  sessionId,
  ...headerProps
}: TerminalNodeHeaderProps) {
  const status = externalState?.status ?? "created";
  const statusLabel = resolveTerminalStatusLabel(feature, status);
  const resolvedSessionId = sessionId ?? externalState?.sessionId ?? null;
  const hasDefaultActions = hasTerminalHeaderDefaultActions(defaultActions);
  const [pendingCloseGuard, setPendingCloseGuard] =
    useState<TerminalCloseGuardResult | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeDiagnostics = resolvedSessionId
    ? createTerminalCloseDiagnostics({
        diagnostics: feature.diagnostics,
        sessionId: resolvedSessionId
      })
    : null;

  const closeTerminal = async (skipConfirmation: boolean) => {
    if (
      !resolvedSessionId ||
      isTerminalSessionEndedStatus(externalState?.status ?? "created")
    ) {
      onCloseRequest?.();
      return;
    }

    setCloseError(null);
    try {
      if (!skipConfirmation) {
        closeDiagnostics?.requested();
        const guard = await feature.closeGuard.check({
          sessionId: resolvedSessionId
        });
        if (guard.requiresConfirmation) {
          setPendingCloseGuard(guard);
          return;
        }
      }

      await feature.launchService.terminate({ sessionId: resolvedSessionId });
      closeDiagnostics?.confirmed();
      setPendingCloseGuard(null);
      onCloseRequest?.();
    } catch (error) {
      setCloseError(errorMessage(error));
    }
  };

  return (
    <header
      {...headerProps}
      className={joinClassName("workspace-terminal__header", className)}
    >
      {defaultActions}
      <div className="workspace-terminal__header-main">
        <span className="workspace-terminal__title">
          {externalState?.title?.trim() || feature.i18n.t("title")}
        </span>
        <Badge className="workspace-terminal__status-tag" variant="default">
          <StatusDot
            pulse={status === "running" || status === "starting"}
            size="xs"
            tone={resolveTerminalStatusTone(status)}
          />
          {statusLabel}
        </Badge>
      </div>
      {headerAccessory?.({
        externalState,
        sessionId: resolvedSessionId
      })}
      <div
        className="workspace-terminal__actions"
        onDoubleClick={(event) => {
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        {onCloseRequest && !hasDefaultActions ? (
          <button
            aria-label={feature.i18n.t("actions.close")}
            className="workspace-terminal__icon-button"
            onClick={() => {
              void closeTerminal(false);
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            type="button"
          >
            x
          </button>
        ) : null}
      </div>
      <TerminalCloseGuardDialog
        feature={feature}
        leaderCommand={pendingCloseGuard?.leaderCommand}
        onCancel={() => setPendingCloseGuard(null)}
        onConfirm={() => {
          void closeTerminal(true);
        }}
        open={Boolean(pendingCloseGuard)}
      />
      {closeError ? (
        <div className="workspace-terminal__close-error" role="status">
          {closeError}
        </div>
      ) : null}
    </header>
  );
}

export function TerminalCloseGuardDialog({
  feature,
  leaderCommand,
  onCancel,
  onConfirm,
  open
}: TerminalCloseGuardDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="workspace-terminal__close-guard" role="alertdialog">
      <h2>{feature.i18n.t("closeGuard.title")}</h2>
      <p>{feature.i18n.t("closeGuard.description")}</p>
      {leaderCommand ? <code>{leaderCommand}</code> : null}
      <div className="workspace-terminal__close-guard-actions">
        <button onClick={() => onCancel()} type="button">
          {feature.i18n.t("closeGuard.cancel")}
        </button>
        <button onClick={() => onConfirm()} type="button">
          {feature.i18n.t("closeGuard.confirm")}
        </button>
      </div>
    </div>
  );
}

function resolveTerminalStatusLabel(
  feature: TerminalNodeFeature,
  status: TerminalSessionStatus
): string {
  return feature.i18n.t(`status.${status}`);
}

function resolveTerminalStatusTone(
  status: TerminalSessionStatus
): "amber" | "blue" | "green" | "neutral" | "red" {
  switch (status) {
    case "running":
    case "starting":
      return "blue";
    case "exited":
      return "green";
    case "failed":
      return "red";
    case "detached":
      return "amber";
    case "created":
      return "neutral";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function joinClassName(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}
