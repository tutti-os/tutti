import type { JSX } from "react";
import {
  Button,
  LoadingIcon,
  SuccessFilledIcon,
  WarningFilledIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "../../../i18n/index";
import { agentGuiDockIconUrls } from "../../../dockIcons";
import type {
  AgentGUIAgentTarget,
  AgentGUIProviderUpdateNotice,
  AgentGUIProviderUpdateNoticeAction
} from "../../../types";
import { projectAgentGUIAgentTargetName } from "../model/agentGuiTargetName";
import { useOptionalAgentTargetSetupController } from "../../../shared/agentEnv/agentTargetSetupController";

interface AgentGUIProviderUpdateNoticesProps {
  agentTargets: readonly AgentGUIAgentTarget[];
  notices: readonly AgentGUIProviderUpdateNotice[];
  onAction?: (input: {
    action: AgentGUIProviderUpdateNoticeAction;
    notice: AgentGUIProviderUpdateNotice;
  }) => void;
  ownerSeparator: string;
}

export function AgentGUIProviderUpdateNotices({
  agentTargets,
  notices,
  onAction,
  ownerSeparator
}: AgentGUIProviderUpdateNoticesProps): JSX.Element | null {
  const { t } = useTranslation();
  const setupController = useOptionalAgentTargetSetupController();
  if (!onAction) {
    return null;
  }
  const presentations = notices.flatMap((notice) => {
    const target = agentTargets.find(
      (candidate) =>
        (candidate.agentTargetId?.trim() || candidate.targetId.trim()) ===
        notice.agentTargetId
    );
    return target ? [{ notice, target }] : [];
  });
  if (presentations.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={t("agentHost.agentGui.updateNoticeRegionLabel")}
      className="w-full divide-y divide-[var(--border-1)] overflow-hidden rounded-[12px] border border-[var(--border-1)] bg-[var(--background-fronted)] shadow-[0_14px_40px_var(--shadow-elevated)]"
      role="region"
    >
      {presentations.map(({ notice, target }) => {
        const label = projectAgentGUIAgentTargetName({
          ownerSeparator,
          target
        }).fullLabel;
        const updating = notice.phase === "updating";
        const completed = notice.phase === "completed";
        const runAction = (action: AgentGUIProviderUpdateNoticeAction) => {
          if (
            action === "details" &&
            notice.detailsTarget === "target-runtime" &&
            setupController?.getSnapshot().agentTargetId ===
              notice.agentTargetId
          ) {
            setupController.setDialogOpen(true);
            return;
          }
          onAction({ action, notice });
        };
        return (
          <section
            key={`${notice.agentTargetId}:${notice.latestVersion}`}
            className={`flex min-w-0 flex-wrap items-center gap-2.5 px-3 py-2 ${
              notice.phase === "failed"
                ? "bg-[var(--on-danger)] shadow-[inset_0_0_0_1px_var(--on-danger-hover)]"
                : ""
            }`}
            data-agent-cli-update-target={notice.agentTargetId}
          >
            <img
              alt=""
              aria-hidden="true"
              className="size-8 shrink-0 rounded-[8px] object-contain"
              draggable={false}
              src={
                target.iconUrl?.trim() || agentGuiDockIconUrls[target.provider]
              }
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-[var(--text-primary)]">
                {t(
                  completed
                    ? "agentHost.agentGui.updateNoticeCompletedTitle"
                    : "agentHost.agentGui.updateNoticeTitle",
                  { agent: label }
                )}
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                {completed ? null : (
                  <span className="truncate">
                    {t("agentHost.agentGui.updateNoticeVersions", {
                      current: notice.currentVersion,
                      latest: notice.latestVersion
                    })}
                  </span>
                )}
                {notice.phase === "available" ? null : (
                  <span
                    aria-live="polite"
                    className={
                      notice.phase === "failed"
                        ? "flex shrink-0 items-center gap-1 text-[var(--state-danger)]"
                        : notice.phase === "completed"
                          ? "flex shrink-0 items-center gap-1 text-[var(--state-success)]"
                          : "flex shrink-0 items-center gap-1"
                    }
                    role="status"
                  >
                    {notice.phase === "failed" ? (
                      <WarningFilledIcon
                        aria-hidden="true"
                        className="size-3.5"
                      />
                    ) : notice.phase === "completed" ? (
                      <SuccessFilledIcon
                        aria-hidden="true"
                        className="size-3.5"
                      />
                    ) : (
                      <LoadingIcon
                        aria-hidden="true"
                        className="size-3.5 animate-spin"
                      />
                    )}
                    {notice.phase === "failed"
                      ? t("agentHost.agentGui.updateNoticeFailed")
                      : notice.phase === "completed"
                        ? t("agentHost.agentGui.updateNoticeCompleted", {
                            version: notice.latestVersion
                          })
                        : t("agentHost.agentGui.updateNoticeUpdating")}
                  </span>
                )}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {completed ? null : (
                <Button
                  type="button"
                  size="xs"
                  disabled={updating}
                  onClick={() => runAction("update")}
                >
                  {updating ? (
                    <LoadingIcon className="size-4 animate-spin" />
                  ) : null}
                  {notice.phase === "failed"
                    ? t("agentHost.agentGui.updateNoticeRetry")
                    : updating
                      ? t("agentHost.agentGui.updateNoticeUpdating")
                      : t("agentHost.agentGui.updateNoticeUpdate")}
                </Button>
              )}
              {!updating && !completed ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => runAction("later")}
                >
                  {t("agentHost.agentGui.updateNoticeLater")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => runAction("details")}
              >
                {t("agentHost.agentGui.updateNoticeDetails")}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
