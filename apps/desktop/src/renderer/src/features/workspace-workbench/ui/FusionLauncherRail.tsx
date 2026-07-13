import { Fragment, type CSSProperties, type ReactNode } from "react";
import {
  AddIcon,
  Button,
  CloseIcon,
  SettingsIcon,
  cn
} from "@tutti-os/ui-system";
import type { WorkbenchHostDockEntryBadge } from "@tutti-os/workbench-surface";
import {
  desktopFusionDockLayout,
  type DesktopFusionState,
  type DesktopFusionWindowDescriptor
} from "@shared/contracts/fusion.ts";
import { useTranslation } from "@renderer/i18n";
import type { FusionBackgroundResource } from "../services/fusionDockResourceModel.ts";
import {
  isFusionDockLauncherBlocked,
  projectFusionDockLauncherInstanceCounts,
  type FusionDockLauncherInstanceCounts,
  type FusionDockLauncher
} from "../services/fusionDockLauncherModel.ts";
import { fusionKindLabelKey } from "../services/fusionDockViewModel.ts";
import { shortcutErrorKey } from "./FusionDockLists.tsx";

export function FusionLauncherRail({
  actionError,
  launchers,
  onActivate,
  onHide,
  onOpenSettings,
  resources,
  shortcutError,
  windows,
  workspaceId
}: {
  actionError: boolean;
  launchers: readonly FusionDockLauncher[];
  onActivate(launcher: FusionDockLauncher, forceNew?: boolean): void;
  onHide(): void;
  onOpenSettings(): void;
  resources: readonly FusionBackgroundResource[];
  shortcutError: DesktopFusionState["shortcut"]["error"];
  windows: readonly DesktopFusionWindowDescriptor[];
  workspaceId: string;
}): ReactNode {
  const { t } = useTranslation();
  const shortcutErrorText = shortcutError
    ? t(shortcutErrorKey(shortcutError))
    : null;
  const settingsWindowCount = windows.filter(
    (window) => window.workspaceId === workspaceId && window.kind === "settings"
  ).length;
  const settingsLabel = t(fusionKindLabelKey("settings"));
  const settingsAriaLabel = [
    settingsLabel,
    settingsWindowCount > 0
      ? t("workspace.fusion.nativeWindowCount", {
          count: settingsWindowCount
        })
      : null,
    shortcutErrorText
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <nav
      aria-label={t("workspace.fusion.launchers")}
      className="flex shrink-0 flex-col items-center overflow-hidden py-2"
      style={{ width: desktopFusionDockLayout.launcherRailWidthPx }}
    >
      <span
        aria-hidden
        className="h-2.5 w-full shrink-0 cursor-grab active:cursor-grabbing [-webkit-app-region:drag]"
      />
      <div
        className="desktop-dock desktop-dock--fixed-metrics min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-dock-placement="left"
        style={
          {
            "--desktop-dock-left-indicator-gutter": "0px",
            height: "100%",
            maxHeight: "none",
            maxWidth: "none",
            minHeight: 0,
            minWidth: 0,
            width: "100%"
          } as CSSProperties
        }
      >
        <div
          className="desktop-dock__items h-full w-full overflow-x-hidden overflow-y-auto"
          style={{
            alignItems: "center",
            height: "100%",
            justifyContent: "flex-start",
            overflowX: "hidden",
            overflowY: "auto",
            width: "100%"
          }}
        >
          {launchers.map((launcher, index) => {
            const previousSectionId =
              index > 0 ? (launchers[index - 1]?.entry.sectionId ?? "") : null;
            const sectionId = launcher.entry.sectionId ?? "";
            const counts = projectFusionDockLauncherInstanceCounts({
              launcher,
              resources,
              windows
            });
            return (
              <Fragment key={launcher.entry.id}>
                {previousSectionId !== null &&
                previousSectionId !== sectionId ? (
                  <span
                    aria-hidden
                    className="desktop-dock__separator"
                    style={{ alignSelf: "center", marginLeft: 0 }}
                  />
                ) : null}
                <FusionLauncherRailItem
                  counts={counts}
                  launcher={launcher}
                  onActivate={onActivate}
                />
                {launcher.entry.separatorAfter ? (
                  <span
                    aria-hidden
                    className="desktop-dock__separator"
                    style={{ alignSelf: "center", marginLeft: 0 }}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex w-[58px] shrink-0 flex-col items-center gap-1 border-t border-[var(--border-1)] pt-2 [-webkit-app-region:no-drag]">
        <div className="relative">
          <Button
            aria-label={settingsAriaLabel}
            className="size-10 rounded-xl p-0"
            title={shortcutErrorText ?? undefined}
            variant="ghost"
            onClick={onOpenSettings}
          >
            <SettingsIcon size={19} />
            {settingsWindowCount > 0 ? (
              <span className="absolute right-0 top-0 grid min-w-4 place-items-center rounded-full bg-[var(--text-primary)] px-1 text-[10px] font-semibold leading-4 text-[var(--text-inverted)]">
                {settingsWindowCount}
              </span>
            ) : null}
          </Button>
          {shortcutErrorText || actionError ? (
            <span
              aria-label={
                shortcutErrorText ?? t("workspace.fusion.actionFailed")
              }
              className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-[var(--state-danger)] text-[10px] font-bold leading-none text-[var(--text-inverted)]"
              role="status"
              title={shortcutErrorText ?? t("workspace.fusion.actionFailed")}
            >
              !
            </span>
          ) : null}
        </div>
        <Button
          aria-label={t("workspace.fusion.hideDock")}
          className="size-9 rounded-xl p-0"
          variant="ghost"
          onClick={onHide}
        >
          <CloseIcon size={16} />
        </Button>
      </div>
    </nav>
  );
}

function FusionLauncherRailItem({
  counts,
  launcher,
  onActivate
}: {
  counts: FusionDockLauncherInstanceCounts;
  launcher: FusionDockLauncher;
  onActivate(launcher: FusionDockLauncher, forceNew?: boolean): void;
}): ReactNode {
  const { t } = useTranslation();
  const blocked = isFusionDockLauncherBlocked(launcher);
  const stateKind = launcher.entry.state?.kind ?? "enabled";
  const windowCountLabel = t("workspace.fusion.nativeWindowCount", {
    count: counts.windowCount
  });
  const backgroundStatusLabel = counts.backgroundStatus
    ? t(fusionBackgroundStatusKey(counts.backgroundStatus))
    : null;
  const backgroundCountLabel = [
    `${t("workspace.fusion.backgroundTasks")}: ${counts.backgroundOnlyCount}`,
    backgroundStatusLabel
  ]
    .filter(Boolean)
    .join(" · ");
  const instanceLabels = [
    counts.windowCount > 0 ? windowCountLabel : null,
    counts.backgroundOnlyCount > 0 ? backgroundCountLabel : null
  ].filter(Boolean);
  return (
    <span
      className="desktop-dock__slot group"
      data-attention-active={
        launcher.entry.attentionToken !== null &&
        launcher.entry.attentionToken !== undefined
          ? "true"
          : undefined
      }
      data-entry-state={stateKind}
      data-icon-size={launcher.entry.iconSize}
      data-background-task-count={counts.backgroundOnlyCount}
      data-native-window-count={counts.windowCount}
      data-node-state={counts.windowCount > 0 ? "open" : "closed"}
    >
      <button
        aria-disabled={blocked || undefined}
        aria-label={[launcher.entry.label, ...instanceLabels].join(". ")}
        className="desktop-dock__btn"
        data-interactive={blocked ? "false" : "true"}
        title={launcher.entry.label}
        type="button"
        onClick={() => {
          if (!blocked) {
            onActivate(launcher);
          }
        }}
      >
        <span className="desktop-dock__icon-shell" data-entry-state={stateKind}>
          <span className="desktop-dock__icon-content">
            {launcher.entry.icon}
          </span>
          {counts.windowCount > 0 ? (
            <span
              aria-label={windowCountLabel}
              className="desktop-dock__count-badge"
              title={windowCountLabel}
            >
              {counts.windowCount}
            </span>
          ) : null}
          {counts.backgroundOnlyCount > 0 ? (
            <span
              aria-label={backgroundCountLabel}
              className={cn(
                "absolute -right-1 -top-1 z-[3] grid min-w-4 place-items-center rounded-full border border-dashed bg-[var(--background-fronted)] px-1 text-[10px] font-semibold leading-[14px] shadow-sm",
                counts.backgroundStatus === "failed"
                  ? "border-[var(--state-danger)] text-[var(--state-danger)]"
                  : counts.backgroundStatus === "warning"
                    ? "border-[var(--state-warning)] text-[var(--state-warning)]"
                    : "border-[var(--state-success)] text-[var(--state-success)]"
              )}
              data-fusion-background-count="true"
              data-status={counts.backgroundStatus ?? undefined}
              title={backgroundCountLabel}
            >
              {counts.backgroundOnlyCount}
            </span>
          ) : null}
          {counts.totalCount === 0 ? (
            <FusionLauncherEntryBadge badge={launcher.entry.badge} />
          ) : null}
        </span>
      </button>
      <Button
        aria-label={t("workspace.fusion.newWindowFor", {
          kind: launcher.entry.label
        })}
        className="pointer-events-none absolute -right-2 top-1/2 z-10 grid size-5 -translate-y-1/2 place-items-center rounded-full border border-[var(--border-1)] bg-[var(--background-fronted)] p-0 text-[var(--text-secondary)] opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100"
        disabled={blocked}
        size="icon-xs"
        variant="ghost"
        onClick={() => onActivate(launcher, true)}
      >
        <AddIcon size={11} />
      </Button>
    </span>
  );
}

function fusionBackgroundStatusKey(
  status: NonNullable<FusionDockLauncherInstanceCounts["backgroundStatus"]>
) {
  switch (status) {
    case "failed":
      return "workspace.fusion.status.failed" as const;
    case "running":
      return "workspace.fusion.status.running" as const;
    case "warning":
      return "workspace.fusion.status.warning" as const;
  }
}

function FusionLauncherEntryBadge({
  badge
}: {
  badge: WorkbenchHostDockEntryBadge | undefined;
}): ReactNode {
  if (!badge) {
    return null;
  }
  if (badge.kind === "count") {
    return <span className="desktop-dock__count-badge">{badge.value}</span>;
  }
  if (badge.kind === "status") {
    return (
      <span
        aria-hidden
        className="desktop-dock__status-badge"
        data-status={badge.status}
      />
    );
  }
  return <span className="desktop-dock__custom-badge">{badge.content}</span>;
}
