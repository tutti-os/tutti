import type { ComponentType, ReactNode } from "react";
import {
  AddIcon,
  AppWindowIcon,
  Button,
  CloseIcon,
  FolderIcon,
  NavAgentsIcon,
  NavApplicationsLinedIcon,
  PlatformIcon,
  SettingsIcon,
  WebIcon,
  cn,
  type IconProps
} from "@tutti-os/ui-system";
import type {
  DesktopFusionState,
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import type { TranslateFn } from "@renderer/i18n";
import type { FusionBackgroundResource } from "../services/fusionDockResourceModel.ts";
import { isFusionDockLauncherBlocked } from "../services/fusionDockLauncherModel.ts";
import {
  fusionKindLabelKey,
  type FusionSearchItem
} from "../services/fusionDockViewModel.ts";

export function FusionSearchResults({
  items,
  onActivate,
  onCloseWindow,
  onStopResource,
  selectedIndex,
  showWorkspaceContext,
  t,
  workspaceNameById
}: {
  items: readonly FusionSearchItem[];
  onActivate(item: FusionSearchItem, forceNew?: boolean): void;
  onCloseWindow(window: DesktopFusionWindowDescriptor): void;
  onStopResource(resource: FusionBackgroundResource): void;
  selectedIndex: number;
  showWorkspaceContext: boolean;
  t: TranslateFn;
  workspaceNameById: Readonly<Record<string, string>>;
}) {
  if (items.length === 0) {
    return (
      <p className="m-0 px-3 py-6 text-center text-xs text-[var(--text-tertiary)]">
        {t("workspace.fusion.noSearchResults")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {items.map((item, index) => {
        const disabled =
          item.kind === "launcher" &&
          isFusionDockLauncherBlocked(item.launcher);
        return (
          <DockRow
            active={index === selectedIndex}
            disabled={disabled}
            icon={fusionSearchItemIcon(item)}
            key={item.id}
            subtitle={fusionSearchItemSubtitle({
              item,
              showWorkspaceContext,
              t,
              workspaceNameById
            })}
            title={item.label}
            trailing={
              <FusionSearchResultActions
                disabled={disabled}
                item={item}
                t={t}
                onActivate={onActivate}
                onCloseWindow={onCloseWindow}
                onStopResource={onStopResource}
              />
            }
            onClick={() => {
              if (!disabled) {
                onActivate(item);
              }
            }}
          />
        );
      })}
    </div>
  );
}

export function FusionKindIcon({
  kind,
  size
}: {
  kind: DesktopFusionWindowKind;
  size: number;
}) {
  const Icon = kindIcons[kind] ?? AppWindowIcon;
  return <Icon aria-hidden size={size} />;
}

export function shortcutErrorKey(
  error: NonNullable<DesktopFusionState["shortcut"]["error"]>
) {
  switch (error) {
    case "conflict":
      return "workspace.fusion.shortcutConflict" as const;
    case "invalid":
      return "workspace.fusion.shortcutInvalid" as const;
    case "unsupported":
      return "workspace.fusion.shortcutUnsupported" as const;
  }
}

function FusionSearchResultActions({
  disabled,
  item,
  onActivate,
  onCloseWindow,
  onStopResource,
  t
}: {
  disabled: boolean;
  item: FusionSearchItem;
  onActivate(item: FusionSearchItem, forceNew?: boolean): void;
  onCloseWindow(window: DesktopFusionWindowDescriptor): void;
  onStopResource(resource: FusionBackgroundResource): void;
  t: TranslateFn;
}) {
  if (item.kind === "command") {
    return null;
  }
  const title =
    item.kind === "launcher"
      ? item.launcher.entry.label
      : item.kind === "window"
        ? (item.window.title ?? t(fusionKindLabelKey(item.window.kind)))
        : item.resource.title;
  return (
    <span className="flex items-center gap-1">
      <Button
        aria-label={t("workspace.fusion.newWindowFor", { kind: title })}
        className="size-7 p-0"
        disabled={disabled}
        size="icon"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation();
          onActivate(item, true);
        }}
      >
        <AddIcon size={12} />
      </Button>
      {item.kind === "window" ? (
        <Button
          aria-label={t("workspace.fusion.closeWindow")}
          className="size-7 p-0"
          size="icon"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onCloseWindow(item.window);
          }}
        >
          <CloseIcon size={13} />
        </Button>
      ) : item.kind === "resource" ? (
        <Button
          aria-label={
            item.resource.canStop
              ? item.resource.kind === "agent"
                ? t("workspace.fusion.cancelAgentTurn")
                : t("workspace.fusion.stopTask")
              : t("workspace.fusion.stopUnavailable")
          }
          className="h-7 px-2 text-[11px]"
          disabled={!item.resource.canStop}
          size="sm"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            onStopResource(item.resource);
          }}
        >
          {item.resource.kind === "agent" && item.resource.canStop
            ? t("workspace.fusion.cancelTurn")
            : t("workspace.fusion.stop")}
        </Button>
      ) : null}
    </span>
  );
}

function fusionSearchItemIcon(item: FusionSearchItem): ReactNode {
  switch (item.kind) {
    case "command":
      return <FusionKindIcon kind="settings" size={17} />;
    case "launcher":
      return item.launcher.entry.icon;
    case "resource":
      return <FusionKindIcon kind={item.resource.kind} size={17} />;
    case "window":
      return <FusionKindIcon kind={item.window.kind} size={17} />;
  }
}

function fusionSearchItemSubtitle(input: {
  item: FusionSearchItem;
  showWorkspaceContext: boolean;
  t: TranslateFn;
  workspaceNameById: Readonly<Record<string, string>>;
}): string {
  const { item, showWorkspaceContext, t, workspaceNameById } = input;
  switch (item.kind) {
    case "command":
    case "launcher":
      return t("workspace.fusion.openOrFocus");
    case "window":
      return [
        showWorkspaceContext
          ? (workspaceNameById[item.window.workspaceId] ??
            item.window.workspaceId)
          : null,
        t(fusionVisibilityKey(item.window.visibility)),
        t("workspace.fusion.windowResult")
      ]
        .filter(Boolean)
        .join(" · ");
    case "resource":
      return [
        showWorkspaceContext ? item.resource.workspaceName : null,
        t(fusionStatusKey(item.resource.status)),
        item.resource.category === "recoverable-session"
          ? t("workspace.fusion.recoverableSession")
          : item.resource.attachedWindowCount > 0
            ? t("workspace.fusion.focusAttachedWindow")
            : t("workspace.fusion.reconnectTask")
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

function DockRow({
  active = false,
  disabled = false,
  icon,
  onClick,
  subtitle,
  title,
  trailing
}: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  onClick(): void;
  subtitle: string;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
        disabled
          ? "cursor-default opacity-55"
          : "cursor-pointer hover:bg-[var(--transparency-hover)]",
        active && !disabled ? "bg-[var(--transparency-block)]" : null
      )}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (disabled || event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-[var(--transparency-block)] text-[var(--text-secondary)] [&_img]:size-full [&_img]:object-contain [&_svg]:size-[18px]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
          {title}
        </span>
        <span className="block truncate text-[10px] text-[var(--text-tertiary)]">
          {subtitle}
        </span>
      </span>
      {trailing}
    </div>
  );
}

const kindIcons: Partial<
  Record<DesktopFusionWindowKind, ComponentType<IconProps>>
> = {
  agent: NavAgentsIcon,
  "app-center": NavApplicationsLinedIcon,
  browser: WebIcon,
  "file-preview": AppWindowIcon,
  files: FolderIcon,
  "issue-manager": AppWindowIcon,
  settings: SettingsIcon,
  terminal: PlatformIcon,
  "workspace-app": AppWindowIcon
};

function fusionVisibilityKey(
  visibility: DesktopFusionWindowDescriptor["visibility"]
) {
  switch (visibility) {
    case "visible":
      return "workspace.fusion.visibility.visible" as const;
    case "minimized":
      return "workspace.fusion.visibility.minimized" as const;
    case "hidden":
      return "workspace.fusion.visibility.hidden" as const;
  }
}

function fusionStatusKey(status: string) {
  switch (status) {
    case "created":
      return "workspace.fusion.status.created" as const;
    case "starting":
      return "workspace.fusion.status.starting" as const;
    case "running":
      return "workspace.fusion.status.running" as const;
    case "waiting":
      return "workspace.fusion.status.waiting" as const;
    case "completed":
      return "workspace.fusion.status.completed" as const;
    case "canceled":
      return "workspace.fusion.status.canceled" as const;
    case "failed":
      return "workspace.fusion.status.failed" as const;
    case "detached":
      return "workspace.fusion.status.detached" as const;
    case "preparing":
      return "workspace.fusion.status.preparing" as const;
    case "installed_pending_restart":
      return "workspace.fusion.status.restartRequired" as const;
    case "stopping":
      return "workspace.fusion.status.stopping" as const;
    default:
      return "workspace.fusion.status.unknown" as const;
  }
}
