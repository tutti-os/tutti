import type { KeyboardEvent, ReactElement } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  GitHubBrandIcon,
  MoreHorizontalIcon,
  NavApplicationsFilledIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RefreshIcon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  UninstallIcon,
  UploadIcon,
  cn
} from "@tutti-os/ui-system";
import type {
  WorkspaceAppActionContext,
  WorkspaceAppAuthorViewModel,
  WorkspaceAppCardViewModel
} from "../contracts/viewModel.ts";
import type { WorkspaceAppInstallProgress } from "../contracts/runtime.ts";
import type {
  WorkspaceAppLocalRepairAgentRequest,
  WorkspaceAppLocalRepairRequest
} from "../contracts/host.ts";
import { isCommunityRecommendedApp } from "../core/appCenterAppOrdering.ts";
import type { AppCenterI18nRuntime } from "../i18n/appCenterI18n.ts";

export interface AppCenterFactoryProviderOption {
  readonly agentTargetId: string;
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
    agentTargetId: string;
    displayName: string;
    model?: string;
    permissionModeId?: string;
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
  readonly loadLocalApp?: () =>
    | Promise<WorkspaceAppLocalRepairRequest | null | void>
    | WorkspaceAppLocalRepairRequest
    | null
    | void;
  readonly openApp?: (
    appId: string,
    context?: WorkspaceAppActionContext
  ) => Promise<void> | void;
  readonly openAppFolder?: (appId: string) => Promise<void> | void;
  readonly openAppPackageFolder?: (appId: string) => Promise<void> | void;
  readonly openExternalUrl?: (url: string) => Promise<void> | void;
  readonly openFactoryJobAgentSession?: (
    agentSessionId: string,
    provider?: string | null,
    agentTargetId?: string | null
  ) => Promise<void> | void;
  readonly modifyAppWithAgent?: (
    jobId: string,
    agentSessionId: string,
    provider?: string | null,
    agentTargetId?: string | null
  ) => Promise<void> | void;
  readonly publishFactoryJob?: (jobId: string) => Promise<void> | void;
  readonly repairLocalApp?: (
    request: WorkspaceAppLocalRepairAgentRequest
  ) => Promise<void> | void;
  readonly replaceAppIcon?: (appId: string) => Promise<void> | void;
  readonly refreshCatalog?: () => Promise<void> | void;
  readonly reloadLocalApp?: (appId: string) => Promise<void> | void;
  readonly retryFactoryValidation?: (jobId: string) => Promise<void> | void;
  readonly retryApp?: (appId: string) => Promise<void> | void;
  readonly restartAndOpenApp?: (appId: string) => Promise<void> | void;
  readonly shouldConfirmAppUpdate?: (appId: string) => boolean;
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
  readonly officialDeveloperIconUrl?: string | null;
  readonly showDeveloperSources?: boolean;
}

export const AppCard = memo(function AppCard({
  actions,
  app,
  className,
  copy,
  officialDeveloperIconUrl = null,
  showDeveloperSources = false
}: AppCardProps): ReactElement {
  const statusLabel = copy.t(app.statusLabelKey);
  const installBusy =
    app.installProgress != null || app.status === "installing";
  const busyStatusLabel = installBusy
    ? copy.t("status.installing")
    : statusLabel;
  const showInstallProgressRing = installBusy;
  const statusButtonTitle = app.installProgress
    ? resolveInstallProgressTitle(copy, app.installProgress, busyStatusLabel)
    : statusLabel;
  const primaryActionLabel =
    app.primaryAction === "install"
      ? copy.t("actions.installApp")
      : app.primaryAction === "retry"
        ? copy.t("actions.retryApp")
        : app.primaryAction === "update"
          ? app.availableVersion
            ? copy.t("labels.updateAvailable", {
                version: app.availableVersion
              })
            : copy.t("actions.updateApp")
          : app.primaryAction === "restartAndOpen"
            ? copy.t("actions.restartAndOpenApp")
            : copy.t("actions.openApp");
  const canExecutePrimaryAction = app.primaryAction !== "none";
  const primaryActionTitle = canExecutePrimaryAction
    ? primaryActionLabel
    : statusButtonTitle;
  const canOpenFromCard = app.canOpen;
  const canPublishFactoryUpdate =
    app.canPublishFactoryUpdate && !!app.factoryJobId;
  const canOpenFactorySession =
    app.canOpenFactorySession &&
    !!app.factoryAgentSessionId &&
    !!app.factoryJobId;
  const communityDeveloper = resolveCommunityAppDeveloper(app);
  const actionContext = useMemo(
    () => createWorkspaceAppActionContext(app),
    [app]
  );
  const hasMoreActions =
    communityDeveloper != null ||
    canPublishFactoryUpdate ||
    canOpenFactorySession ||
    app.canExport ||
    app.canDelete ||
    app.canReplaceIcon ||
    app.canReloadLocal ||
    app.canOpenFolder ||
    app.canOpenPackageFolder ||
    app.canUninstall;
  const executePrimaryAction = useCallback((): void => {
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
    if (app.primaryAction === "restartAndOpen") {
      void actions.restartAndOpenApp?.(app.id);
      return;
    }
    if (app.primaryAction === "open") {
      void actions.openApp?.(app.id, actionContext);
    }
  }, [actionContext, actions, app.id, app.primaryAction]);
  const executeCardAction = useCallback((): void => {
    if (canOpenFromCard) {
      void actions.openApp?.(app.id, actionContext);
    }
  }, [actionContext, actions, app.id, canOpenFromCard]);
  const handleCardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (!canOpenFromCard || (event.key !== "Enter" && event.key !== " ")) {
        return;
      }
      event.preventDefault();
      executeCardAction();
    },
    [canOpenFromCard, executeCardAction]
  );
  const handleReplaceIcon = useCallback((): void => {
    void actions.replaceAppIcon?.(app.id);
  }, [actions, app.id]);

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
      onKeyDown={handleCardKeyDown}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <AppIcon
          app={app}
          replaceIconLabel={copy.t("actions.replaceIcon")}
          onReplaceIcon={handleReplaceIcon}
        />
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <div className="flex size-8 shrink-0 items-center justify-center">
            {hasMoreActions ? (
              <AppCardMoreActions
                actions={actions}
                app={app}
                canOpenFactorySession={canOpenFactorySession}
                canPublishFactoryUpdate={canPublishFactoryUpdate}
                communityDeveloper={communityDeveloper}
                copy={copy}
              />
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              className={cn(
                "min-w-0 max-w-full shrink truncate px-2",
                !canExecutePrimaryAction ? "cursor-default" : null,
                canExecutePrimaryAction
                  ? app.primaryAction === "retry"
                    ? statusClassName(app.status)
                    : "text-[var(--text-primary)]"
                  : statusClassName(app.status)
              )}
              disabled={!canExecutePrimaryAction}
              size="default"
              title={primaryActionTitle}
              type="button"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                executePrimaryAction();
              }}
            >
              <span className="block min-w-0 max-w-full truncate">
                {canExecutePrimaryAction ? primaryActionLabel : busyStatusLabel}
              </span>
            </Button>
            {showInstallProgressRing ? (
              <AppInstallProgressRing
                ariaLabel={copy.t("status.installProgress.progressAria")}
                fallbackPercent={0}
                progress={app.installProgress}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-5 flex min-h-0 min-w-0 flex-1 flex-col p-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <AppCardTextTooltip
              as="h3"
              className="block min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[0] text-[var(--text-primary)]"
              content={app.name}
            >
              {app.name}
            </AppCardTextTooltip>
            {app.version ? (
              <span className="min-w-0 flex-none text-[11px] leading-4 text-[var(--text-tertiary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                {copy.t("labels.version", { version: app.version })}
              </span>
            ) : null}
            {app.canReloadLocal ? (
              <span className="min-w-0 flex-none rounded-[5px] border border-[color:var(--line-2)] px-1.5 py-0 text-[10px] font-medium leading-4 text-[var(--text-secondary)]">
                {copy.t("labels.localDev")}
              </span>
            ) : null}
          </div>
          {app.description ? (
            <AppCardTextTooltip
              as="p"
              className="mt-2 line-clamp-3 text-[13px] font-normal leading-[1.3] text-[var(--text-secondary)]"
              content={app.description}
            >
              {app.description}
            </AppCardTextTooltip>
          ) : null}
        </div>

        {app.errorMessage ? (
          <div className="mt-auto flex min-w-0 flex-col gap-3 pt-3">
            <p
              className="min-w-0 rounded-[6px] bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] px-2 py-1 text-[11px] leading-4 text-[var(--state-danger)]"
              title={app.errorMessage}
            >
              {copy.t("messages.appRuntimeFailed")}
            </p>
          </div>
        ) : null}

        {showDeveloperSources ? (
          <AppDeveloperSourceRow
            actions={actions}
            app={app}
            copy={copy}
            officialDeveloperIconUrl={officialDeveloperIconUrl}
          />
        ) : null}
      </div>
    </article>
  );
});

function AppCardTextTooltip({
  as,
  children,
  className,
  content
}: {
  readonly as: "h3" | "p";
  readonly children: string;
  readonly className: string;
  readonly content: string;
}): ReactElement {
  const normalizedContent = content.trim();
  const textRef = useRef<HTMLHeadingElement | HTMLParagraphElement | null>(
    null
  );
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = textRef.current;
    if (!element || !normalizedContent) {
      setOverflowing(false);
      return;
    }

    let frame = 0;
    const measure = (): void => {
      frame = 0;
      setOverflowing(
        element.scrollWidth - element.clientWidth > 1 ||
          element.scrollHeight - element.clientHeight > 1
      );
    };
    const queueMeasure = (): void => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(measure);
    };

    queueMeasure();
    window.addEventListener("resize", queueMeasure);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", queueMeasure);
        if (frame !== 0) {
          window.cancelAnimationFrame(frame);
        }
      };
    }

    const observer = new ResizeObserver(queueMeasure);
    observer.observe(element);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", queueMeasure);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [normalizedContent]);

  const textElement =
    as === "h3" ? (
      <h3 ref={textRef} className={className}>
        {children}
      </h3>
    ) : (
      <p ref={textRef} className={className}>
        {children}
      </p>
    );

  if (!normalizedContent) {
    return textElement;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{textElement}</TooltipTrigger>
        {overflowing ? (
          <TooltipContent
            className="max-w-[min(420px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
            collisionPadding={12}
          >
            {normalizedContent}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );
}

function createWorkspaceAppActionContext(
  app: WorkspaceAppCardViewModel
): WorkspaceAppActionContext {
  return {
    installationId: app.installationId ?? null,
    runtimeId: app.runtimeId ?? null,
    launchUrl: app.launchUrl ?? null
  };
}

function AppDeveloperSourceRow({
  actions,
  app,
  copy,
  officialDeveloperIconUrl
}: {
  readonly actions: AppCenterHostActions;
  readonly app: WorkspaceAppCardViewModel;
  readonly copy: AppCenterI18nRuntime;
  readonly officialDeveloperIconUrl?: string | null;
}): ReactElement | null {
  const sourceAuthors = app.authors ?? [];
  const repository = app.repository ?? null;
  const authors =
    sourceAuthors.length > 0
      ? sourceAuthors
      : app.sourceKind === "bundled"
        ? [{ name: "Tutti" }]
        : [];
  const [popoverOpen, setPopoverOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const clearCloseTimer = useCallback((): void => {
    if (closeTimerRef.current === null) {
      return;
    }
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const openPopover = useCallback((): void => {
    clearCloseTimer();
    setPopoverOpen(true);
  }, [clearCloseTimer]);
  const scheduleClosePopover = useCallback((): void => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setPopoverOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [clearCloseTimer]);
  if (authors.length === 0 && repository === null) {
    return null;
  }

  const primaryAuthor = authors[0] ?? null;
  const rowLabel =
    authors.length > 1
      ? copy.t("sources.developerCount", { count: String(authors.length) })
      : primaryAuthor?.name ||
        (repository ? copy.t("sources.githubRepository") : "");
  const official = isOfficialAuthor(primaryAuthor?.name);
  const canOpenPopover =
    repository !== null || authors.some((author) => Boolean(author.url));

  const content = (
    <div className="mt-auto min-w-0 pt-3">
      <div className="group/source flex min-h-7 min-w-0 items-center gap-2 border-t border-[color:var(--line-2)] pt-2 text-[12px] leading-4 text-[var(--text-secondary)]">
        <AvatarStack
          authors={authors}
          fallbackIconUrl={official ? officialDeveloperIconUrl : null}
        />
        <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
        {official ? (
          <span className="shrink-0 rounded-[5px] border border-[color:var(--line-2)] px-1.5 py-0 text-[10px] font-medium leading-4 text-[var(--text-secondary)]">
            {copy.t("sources.official")}
          </span>
        ) : null}
        {canOpenPopover ? (
          <span className="flex size-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
            <GitHubBrandIcon className="size-4 group-hover/source:hidden" />
            <span
              aria-hidden="true"
              className="hidden text-[18px] leading-none group-hover/source:block"
            >
              ›
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );

  if (!canOpenPopover) {
    return content;
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          className="block w-full min-w-0 border-0 bg-transparent p-0 text-left"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
          }}
          onPointerEnter={openPopover}
          onPointerLeave={scheduleClosePopover}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[280px] max-w-[min(280px,calc(100vw-32px))]"
        collisionPadding={12}
        side="bottom"
        style={{ zIndex: "var(--z-panel-popover)" }}
        onPointerEnter={openPopover}
        onPointerLeave={scheduleClosePopover}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="px-2 py-1.5 text-[12px] font-semibold leading-4 text-[var(--text-primary)]">
          {copy.t("sources.title")}
        </div>
        <div className="flex flex-col gap-[2px]">
          {authors.map((author, index) => (
            <button
              className="flex min-h-8 min-w-0 items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] font-normal leading-4 text-[var(--text-primary)] hover:bg-[var(--transparency-hover)] disabled:cursor-default disabled:opacity-60"
              disabled={!author.url}
              key={`${author.name}:${author.url ?? ""}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openExternalURL(actions, author.url);
              }}
            >
              <AuthorAvatar
                author={author}
                fallbackIconUrl={
                  index === 0 && isOfficialAuthor(author.name)
                    ? officialDeveloperIconUrl
                    : null
                }
              />
              <span className="min-w-0 flex-1 truncate">{author.name}</span>
            </button>
          ))}
          {repository ? (
            <button
              className="flex min-h-8 min-w-0 items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] font-normal leading-4 text-[var(--text-primary)] hover:bg-[var(--transparency-hover)]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openExternalURL(actions, repository.url);
              }}
            >
              <GitHubBrandIcon className="size-4" />
              <span className="min-w-0 flex-1 truncate">
                {displayRepositoryURL(repository.url)}
              </span>
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AvatarStack({
  authors,
  fallbackIconUrl
}: {
  readonly authors: readonly WorkspaceAppAuthorViewModel[];
  readonly fallbackIconUrl?: string | null;
}): ReactElement {
  const visibleAuthors = authors.slice(0, 2);
  if (visibleAuthors.length === 0) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--transparency-block)]">
        <GitHubBrandIcon className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="flex shrink-0 -space-x-1">
      {visibleAuthors.map((author, index) => (
        <AuthorAvatar
          author={author}
          fallbackIconUrl={index === 0 ? fallbackIconUrl : null}
          key={`${author.name}:${author.url ?? ""}`}
        />
      ))}
    </span>
  );
}

function AuthorAvatar({
  author,
  fallbackIconUrl
}: {
  readonly author: WorkspaceAppAuthorViewModel;
  readonly fallbackIconUrl?: string | null;
}): ReactElement {
  if (author.avatarUrl) {
    return (
      <img
        alt=""
        className="size-5 shrink-0 rounded-full border border-[var(--background-fronted)] object-cover"
        draggable={false}
        src={author.avatarUrl}
      />
    );
  }
  if (fallbackIconUrl) {
    return (
      <img
        alt=""
        className="size-5 shrink-0 rounded-[5px] border border-[var(--background-fronted)] object-contain"
        draggable={false}
        src={fallbackIconUrl}
      />
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--background-fronted)] bg-[var(--transparency-block)] text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
      {author.name.slice(0, 1)}
    </span>
  );
}

function isOfficialAuthor(name: string | null | undefined): boolean {
  const normalized = name?.trim().toLowerCase() ?? "";
  return normalized === "tutti" || normalized === "tutti official";
}

function displayRepositoryURL(url: string): string {
  return url.replace(/^https?:\/\//u, "");
}

function openExternalURL(
  actions: AppCenterHostActions,
  url: string | null | undefined
): void {
  const target = url?.trim();
  if (!target) {
    return;
  }
  if (actions.openExternalUrl) {
    void actions.openExternalUrl(target);
    return;
  }
  window.open(target, "_blank", "noopener,noreferrer");
}

function AppCardMoreActions({
  actions,
  app,
  canOpenFactorySession,
  canPublishFactoryUpdate,
  communityDeveloper,
  copy
}: {
  readonly actions: AppCenterHostActions;
  readonly app: WorkspaceAppCardViewModel;
  readonly canOpenFactorySession: boolean;
  readonly canPublishFactoryUpdate: boolean;
  readonly communityDeveloper: WorkspaceAppAuthorViewModel | null;
  readonly copy: AppCenterI18nRuntime;
}): ReactElement {
  const menuItems: AppCenterActionMenuItem[] = [];

  if (communityDeveloper) {
    menuItems.push({
      content: (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0">{copy.t("sources.developer")}</span>
          <AuthorAvatar author={communityDeveloper} />
          <span className="min-w-0 flex-1 truncate">
            {communityDeveloper.name}
          </span>
        </span>
      ),
      key: "developer",
      label: copy.t("sources.developerMenuLabel", {
        name: communityDeveloper.name
      }),
      onSelect: () => {
        openExternalURL(actions, communityDeveloper.url);
      }
    });
  }

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
        if (app.factoryEditAction === "open_session") {
          void actions.openFactoryJobAgentSession?.(
            app.factoryAgentSessionId ?? "",
            app.factoryProvider,
            app.factoryAgentTargetId
          );
          return;
        }
        void actions.modifyAppWithAgent?.(
          app.factoryJobId ?? "",
          app.factoryAgentSessionId ?? "",
          app.factoryProvider,
          app.factoryAgentTargetId
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

  if (app.canReloadLocal) {
    menuItems.push({
      icon: <RefreshIcon />,
      key: "reload-local",
      label: copy.t("actions.reloadLocalApp"),
      onSelect: () => {
        void actions.reloadLocalApp?.(app.id);
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
  readonly content?: ReactElement;
  readonly icon?: ReactElement;
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
              {item.content ?? (
                <>
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </>
              )}
              {item.attention ? (
                <i
                  aria-hidden="true"
                  className="ml-2 block size-1.5 shrink-0 rounded-full bg-[var(--state-danger)] not-italic"
                />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function resolveCommunityAppDeveloper(
  app: WorkspaceAppCardViewModel
): WorkspaceAppAuthorViewModel | null {
  if (!isCommunityRecommendedApp(app.id)) {
    return null;
  }
  return (
    app.authors?.find(
      (author) => author.name.trim() && Boolean(author.url?.trim())
    ) ?? null
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

function AppInstallProgressRing({
  ariaLabel,
  fallbackPercent,
  progress
}: {
  readonly ariaLabel: string;
  readonly fallbackPercent: number;
  readonly progress: WorkspaceAppInstallProgress | null | undefined;
}): ReactElement {
  const percent =
    progress == null
      ? Math.max(0, Math.min(100, Math.round(fallbackPercent)))
      : Math.max(0, Math.min(100, Math.round(progress.overallPercent)));

  return (
    <span
      aria-label={ariaLabel}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className="relative inline-flex size-[14px] shrink-0 items-center justify-center rounded-full"
      role="progressbar"
      style={{
        background: `conic-gradient(var(--text-secondary) ${percent}%, color-mix(in srgb, var(--text-secondary) 24%, transparent) 0)`
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-[2px] rounded-full bg-[var(--surface-panel)]"
      />
    </span>
  );
}

function resolveInstallProgressTitle(
  copy: AppCenterI18nRuntime,
  progress: WorkspaceAppInstallProgress,
  statusLabel: string
): string {
  const byteLabel = formatInstallProgressBytes(copy, progress);
  const percent = Math.max(
    0,
    Math.min(100, Math.round(progress.overallPercent))
  );
  if (byteLabel) {
    return `${statusLabel} · ${byteLabel} · ${percent}%`;
  }
  return `${statusLabel} · ${percent}%`;
}

function formatInstallProgressBytes(
  copy: AppCenterI18nRuntime,
  progress: WorkspaceAppInstallProgress
): string | null {
  if (
    progress.userPhase !== "downloading" ||
    progress.downloadedBytes == null
  ) {
    return null;
  }
  const downloaded = formatByteSize(progress.downloadedBytes);
  if (progress.totalBytes == null || progress.totalBytes <= 0) {
    return downloaded;
  }
  return copy.t("status.installProgress.downloadedOfTotal", {
    downloaded,
    total: formatByteSize(progress.totalBytes)
  });
}

function formatByteSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"] as const;
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function statusClassName(status: WorkspaceAppCardViewModel["status"]): string {
  if (status === "failed") {
    return "text-[var(--state-danger)]";
  }
  if (status === "unavailable") {
    return "text-[var(--state-warning)]";
  }
  if (status === "running") {
    return "text-[var(--text-primary)]";
  }
  return "text-[var(--text-secondary)]";
}
