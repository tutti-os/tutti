import type { ReactElement } from "react";
import {
  Button,
  ChatIcon,
  DeleteIcon,
  EditIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FolderIcon,
  MoreHorizontalIcon,
  NavApplicationsFilledIcon,
  UninstallIcon,
  UploadIcon,
  cn
} from "@tutti-os/ui-system";
import type { WorkspaceAppCardViewModel } from "../contracts/viewModel.ts";
import type { AppCenterI18nRuntime } from "../i18n/appCenterI18n.ts";

export interface AppCenterFactoryProviderOption {
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly iconUrl?: string | null;
  readonly label: string;
  readonly provider: string;
}

export interface AppCenterFactoryModelOption {
  readonly label: string;
  readonly value: string;
}

export interface AppCenterFactoryReasoningOption {
  readonly label: string;
  readonly value: string;
}

export interface AppCenterFactoryPermissionOption {
  readonly label: string;
  readonly semantic?: string | null;
  readonly value: string;
}

export interface AppCenterFactoryProviderConfiguration {
  readonly defaultModel?: string | null;
  readonly defaultPermissionModeId?: string | null;
  readonly defaultReasoningEffort?: string | null;
  readonly modelOptions: readonly AppCenterFactoryModelOption[];
  readonly permissionModeOptions: readonly AppCenterFactoryPermissionOption[];
  readonly reasoningEffortOptions: readonly AppCenterFactoryReasoningOption[];
}

export interface AppCenterHostActions {
  readonly cancelFactoryJob?: (jobId: string) => Promise<void> | void;
  readonly createFactoryJob?: (input: {
    displayName: string;
    model?: string;
    permissionModeId?: string;
    provider?: string;
    prompt: string;
    reasoningEffort?: string;
  }) => Promise<void> | void;
  readonly deleteApp?: (appId: string, appName: string) => Promise<void> | void;
  readonly deleteFactoryJob?: (jobId: string) => Promise<void> | void;
  readonly exportApp?: (appId: string) => Promise<void> | void;
  readonly fixFactoryJob?: (
    jobId: string,
    prompt: string
  ) => Promise<void> | void;
  readonly importApp?: () => Promise<void> | void;
  readonly installApp?: (appId: string) => Promise<void> | void;
  readonly openApp?: (appId: string) => Promise<void> | void;
  readonly openAppFolder?: (appId: string) => Promise<void> | void;
  readonly openAppPackageFolder?: (appId: string) => Promise<void> | void;
  readonly openFactoryJobAgentSession?: (
    agentSessionId: string,
    provider?: string | null
  ) => Promise<void> | void;
  readonly modifyAppWithAgent?: (
    jobId: string,
    agentSessionId: string,
    provider?: string | null
  ) => Promise<void> | void;
  readonly publishFactoryJob?: (jobId: string) => Promise<void> | void;
  readonly replaceAppIcon?: (appId: string) => Promise<void> | void;
  readonly refreshCatalog?: () => Promise<void> | void;
  readonly retryFactoryValidation?: (jobId: string) => Promise<void> | void;
  readonly retryApp?: (appId: string) => Promise<void> | void;
  readonly updateApp?: (
    appId: string,
    trigger: "badge_button" | "primary_action"
  ) => Promise<void> | void;
  readonly uninstallApp?: (appId: string) => Promise<void> | void;
}

export interface AppCardProps {
  readonly actions: AppCenterHostActions;
  readonly app: WorkspaceAppCardViewModel;
  readonly className?: string;
  readonly copy: AppCenterI18nRuntime;
}

export function AppCard({
  actions,
  app,
  className,
  copy
}: AppCardProps): ReactElement {
  const statusLabel = copy.t(app.statusLabelKey);
  const primaryActionLabel =
    app.primaryAction === "install"
      ? copy.t("actions.installApp")
      : app.primaryAction === "retry"
        ? copy.t("actions.retryApp")
        : app.primaryAction === "update"
          ? copy.t("actions.updateApp")
          : copy.t("actions.openApp");
  const canExecutePrimaryAction = app.primaryAction !== "none";
  const canOpenFromCard = app.canOpen;
  const canPublishFactoryUpdate =
    app.canPublishFactoryUpdate && !!app.factoryJobId;
  const canOpenFactorySession =
    app.canOpenFactorySession &&
    !!app.factoryAgentSessionId &&
    !!app.factoryJobId;
  const hasMoreActions =
    canPublishFactoryUpdate ||
    canOpenFactorySession ||
    app.canExport ||
    app.canDelete ||
    app.canReplaceIcon ||
    app.canOpenFolder ||
    app.canOpenPackageFolder ||
    app.canUninstall;
  const executePrimaryAction = (): void => {
    if (app.primaryAction === "retry") {
      void actions.retryApp?.(app.id);
      return;
    }
    if (app.primaryAction === "install") {
      void actions.installApp?.(app.id);
      return;
    }
    if (app.primaryAction === "update") {
      void actions.updateApp?.(app.id, "primary_action");
      return;
    }
    if (app.primaryAction === "open") {
      void actions.openApp?.(app.id);
    }
  };
  const executeCardAction = (): void => {
    if (canOpenFromCard) {
      void actions.openApp?.(app.id);
    }
  };

  return (
    <article
      aria-disabled={canOpenFromCard ? undefined : true}
      className={cn(
        "group flex h-full min-h-[168px] min-w-0 flex-col rounded-[12px] border border-[color:var(--line-2)] bg-[var(--background-fronted)] p-[12px] text-left text-[var(--text-primary)] transition-transform duration-200 ease-out will-change-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--border-focus)_70%,transparent)] motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        canOpenFromCard ? "cursor-pointer" : "cursor-default",
        className
      )}
      data-app-center-app-id={app.id}
      role="listitem"
      tabIndex={canOpenFromCard ? 0 : -1}
      onClick={executeCardAction}
      onKeyDown={(event) => {
        if (!canOpenFromCard || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        event.preventDefault();
        executeCardAction();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <AppIcon
          app={app}
          replaceIconLabel={copy.t("actions.replaceIcon")}
          onReplaceIcon={() => {
            void actions.replaceAppIcon?.(app.id);
          }}
        />
        <div className="flex shrink-0 items-center gap-1">
          {hasMoreActions ? (
            <AppCardMoreActions
              actions={actions}
              app={app}
              canOpenFactorySession={canOpenFactorySession}
              canPublishFactoryUpdate={canPublishFactoryUpdate}
              copy={copy}
            />
          ) : null}
          <Button
            className={cn(
              "min-w-[56px]",
              !canExecutePrimaryAction ? "cursor-default" : null,
              canExecutePrimaryAction
                ? app.primaryAction === "retry"
                  ? statusClassName(app.status)
                  : "text-[var(--text-primary)]"
                : statusClassName(app.status)
            )}
            disabled={!canExecutePrimaryAction}
            size="default"
            title={statusLabel}
            type="button"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              executePrimaryAction();
            }}
          >
            {canExecutePrimaryAction ? primaryActionLabel : statusLabel}
          </Button>
        </div>
      </div>

      <div className="mt-5 flex min-h-0 min-w-0 flex-1 flex-col p-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="block min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[0] text-[var(--text-primary)]">
              {app.name}
            </h3>
            {app.version ? (
              <span className="min-w-0 flex-none text-[11px] leading-4 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                {copy.t("labels.version", { version: app.version })}
              </span>
            ) : null}
          </div>
          {app.updateAvailable && app.availableVersion ? (
            <button
              className={cn(
                "mt-1 inline-flex max-w-full items-center rounded-[4px] bg-[color-mix(in_srgb,var(--state-warning)_12%,transparent)] px-2 py-0.5 text-[11px] leading-4 text-[var(--state-warning)] outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--state-warning)_18%,transparent)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--state-warning)_42%,transparent)]",
                app.canUpdate ? "cursor-pointer" : "cursor-default"
              )}
              disabled={!app.canUpdate}
              title={copy.t("actions.updateApp")}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (app.canUpdate) {
                  void actions.updateApp?.(app.id, "badge_button");
                }
              }}
            >
              <span className="truncate">
                {copy.t("labels.updateAvailable", {
                  version: app.availableVersion
                })}
              </span>
            </button>
          ) : null}
          {app.description ? (
            <p className="mt-2 line-clamp-3 text-[13px] font-normal leading-[1.3] text-[var(--text-secondary)]">
              {app.description}
            </p>
          ) : null}
        </div>

        {app.errorMessage || app.tags.length > 0 ? (
          <div className="mt-auto flex min-w-0 flex-col gap-3 pt-3">
            {app.errorMessage ? (
              <p
                className="min-w-0 rounded-[6px] bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] px-2 py-1 text-[11px] leading-4 text-[var(--state-danger)]"
                title={app.errorMessage}
              >
                {copy.t("messages.appRuntimeFailed")}
              </p>
            ) : null}
            {app.tags.length > 0 ? (
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {app.tags.slice(0, 3).map((tag) => (
                  <span
                    className="inline-flex h-5 max-w-full items-center rounded-[4px] bg-[var(--transparency-block)] px-2 text-[11px] leading-4 text-[var(--text-secondary)]"
                    key={tag}
                  >
                    <span className="truncate">{tag}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AppCardMoreActions({
  actions,
  app,
  canOpenFactorySession,
  canPublishFactoryUpdate,
  copy
}: {
  readonly actions: AppCenterHostActions;
  readonly app: WorkspaceAppCardViewModel;
  readonly canOpenFactorySession: boolean;
  readonly canPublishFactoryUpdate: boolean;
  readonly copy: AppCenterI18nRuntime;
}): ReactElement {
  const menuItems: AppCenterActionMenuItem[] = [];

  if (canPublishFactoryUpdate) {
    menuItems.push({
      attention: true,
      icon: <UploadIcon />,
      key: "publish",
      label: copy.t("actions.publishAppUpdate"),
      onSelect: () => {
        void actions.publishFactoryJob?.(app.factoryJobId ?? "");
      }
    });
  }

  if (canOpenFactorySession) {
    menuItems.push({
      icon: <ChatIcon />,
      key: "modify-app-with-agent",
      label: copy.t("actions.modifyAppWithAgent"),
      onSelect: () => {
        void actions.modifyAppWithAgent?.(
          app.factoryJobId ?? "",
          app.factoryAgentSessionId ?? "",
          app.factoryProvider
        );
      }
    });
  }

  if (app.canReplaceIcon) {
    menuItems.push({
      icon: <EditIcon />,
      key: "replace-icon",
      label: copy.t("actions.replaceIcon"),
      onSelect: () => {
        void actions.replaceAppIcon?.(app.id);
      }
    });
  }

  if (app.canOpenFolder) {
    menuItems.push({
      icon: <FolderIcon />,
      key: "open-folder",
      label: copy.t("actions.openAppFolder"),
      onSelect: () => {
        void actions.openAppFolder?.(app.id);
      }
    });
  }

  if (app.canOpenPackageFolder) {
    menuItems.push({
      icon: <FolderIcon />,
      key: "open-package-folder",
      label: copy.t("actions.openAppPackageFolder"),
      onSelect: () => {
        void actions.openAppPackageFolder?.(app.id);
      }
    });
  }

  if (app.canExport) {
    menuItems.push({
      icon: <UploadIcon />,
      key: "export",
      label: copy.t("actions.exportApp"),
      onSelect: () => {
        void actions.exportApp?.(app.id);
      }
    });
  }

  if (app.canUninstall) {
    menuItems.push({
      icon: <UninstallIcon />,
      key: "uninstall",
      label: copy.t("actions.uninstallApp"),
      onSelect: () => {
        void actions.uninstallApp?.(app.id);
      },
      variant: "destructive"
    });
  }

  if (app.canDelete) {
    menuItems.push({
      icon: <DeleteIcon />,
      key: "delete",
      label: copy.t(
        app.installed ? "actions.uninstallAndDeleteApp" : "actions.deleteApp"
      ),
      onSelect: () => {
        void actions.deleteApp?.(app.id, app.name);
      },
      variant: "destructive"
    });
  }

  return (
    <AppCenterActionMenu
      ariaLabel={copy.t("actions.moreActions")}
      attention={canPublishFactoryUpdate}
      items={menuItems}
      triggerTitle={copy.t("actions.moreActions")}
    />
  );
}

interface AppCenterActionMenuItem {
  readonly attention?: boolean;
  readonly icon: ReactElement;
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly variant?: "default" | "destructive";
}

function AppCenterActionMenu({
  ariaLabel,
  attention = false,
  items,
  triggerTitle
}: {
  readonly ariaLabel: string;
  readonly attention?: boolean;
  readonly items: readonly AppCenterActionMenuItem[];
  readonly triggerTitle: string;
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={ariaLabel}
          className="relative"
          size="icon"
          title={triggerTitle}
          type="button"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <MoreHorizontalIcon />
          {attention ? (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-[var(--state-danger)] shadow-[0_0_0_2px_var(--background-fronted)]"
            />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[192px]"
        collisionPadding={12}
        side="bottom"
        style={{ zIndex: "var(--z-panel-popover)" }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        <DropdownMenuGroup className="gap-[2px]">
          {items.map((item) => (
            <DropdownMenuItem
              className="font-normal"
              key={item.key}
              variant={item.variant}
              onSelect={(event) => {
                event.stopPropagation();
                item.onSelect();
              }}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.attention ? (
                <span
                  aria-hidden="true"
                  className="ml-2 size-1.5 flex-none rounded-full bg-[var(--state-danger)]"
                />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppIcon({
  app,
  onReplaceIcon,
  replaceIconLabel
}: {
  readonly app: WorkspaceAppCardViewModel;
  readonly onReplaceIcon: () => void;
  readonly replaceIconLabel: string;
}): ReactElement {
  const icon =
    app.icon?.type === "asset" ? (
      <img
        alt=""
        className="size-11 flex-none rounded-[10px] object-contain object-center select-none"
        draggable={false}
        src={app.icon.src}
      />
    ) : (
      <span className="flex size-11 flex-none items-center justify-center rounded-[10px] bg-[var(--transparency-block)] text-[var(--text-secondary)]">
        <NavApplicationsFilledIcon className="size-[22px]" />
      </span>
    );

  return (
    <span className="group/app-icon relative block size-11 flex-none">
      {icon}
      {app.canReplaceIcon ? (
        <button
          aria-label={replaceIconLabel}
          className="absolute inset-0 flex size-11 items-center justify-center rounded-[10px] bg-black/55 p-0 text-white opacity-0 transition-opacity duration-150 group-hover/app-icon:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--border-focus)_70%,transparent)]"
          title={replaceIconLabel}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            onReplaceIcon();
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <EditIcon className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}

function statusClassName(status: WorkspaceAppCardViewModel["status"]): string {
  if (status === "failed") {
    return "text-[var(--state-danger)]";
  }
  if (status === "running") {
    return "text-[var(--text-primary)]";
  }
  return "text-[var(--text-secondary)]";
}
