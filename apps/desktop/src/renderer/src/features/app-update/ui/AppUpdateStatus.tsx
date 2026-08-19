import { useEffect, useState } from "react";
import {
  Button,
  DownloadIcon,
  LoadingIcon,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  RefreshIcon
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useAppUpdateService } from "./useAppUpdateService";
import {
  resolveStandaloneAppUpdateStatusPresentation,
  shouldShowReleaseNotesAction
} from "./appUpdateStatusPresentation";

const updateIconUrl = new URL("../assets/update.png", import.meta.url).href;
const tuttiIconUrl = new URL("../assets/tutti.png", import.meta.url).href;

export function AppUpdateStatus({
  density = "default",
  presentation = "workspace"
}: {
  density?: "compact" | "default";
  presentation?: "standalone" | "workspace";
}) {
  const { t } = useTranslation();
  const { service, state } = useAppUpdateService();

  const view = state.view;

  if (presentation === "standalone") {
    return (
      <StandaloneAppUpdateStatus
        isActing={state.isActing}
        openReleaseNotes={() => service.openReleaseNotes()}
        runPrimaryAction={() => service.runPrimaryAction()}
        showReleaseNotes={shouldShowReleaseNotesAction(
          state.updateState?.channel,
          view.action
        )}
        view={view}
      />
    );
  }

  if (!view.visible || !view.titleKey) {
    return null;
  }

  const label = t(view.titleKey, view.titleParams);
  const compact = density === "compact";
  const showReleaseNotesAction = shouldShowReleaseNotesAction(
    state.updateState?.channel,
    view.action
  );

  return (
    <div
      className={cn(
        "inline-flex h-7 max-w-[min(18rem,30vw)] items-center justify-between",
        compact
          ? "gap-1.5 text-[13px]"
          : "gap-2.5 text-[13px] max-[700px]:max-w-[calc(100vw-12rem)] max-[700px]:gap-2"
      )}
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5">
        <RotatingUpdateIcon />
        <span className="inline-flex h-7 min-w-0 items-center truncate whitespace-nowrap text-[13px] font-semibold text-[var(--workbench-chrome-foreground)]">
          {label}
        </span>
      </div>

      {view.action && view.actionKey ? (
        <>
          {showReleaseNotesAction ? (
            <Button
              onClick={() => void service.openReleaseNotes()}
              size={compact ? "xs" : "sm"}
              type="button"
              variant="ghost"
            >
              {t("updates.releaseNotesAction")}
            </Button>
          ) : null}
          <Button
            disabled={view.busy}
            onClick={() => {
              void service.runPrimaryAction();
            }}
            size={compact ? "xs" : "sm"}
            variant="secondary"
            className={cn(
              "text-[var(--workbench-chrome-foreground)] hover:text-[var(--workbench-chrome-foreground)] disabled:opacity-60",
              compact
                ? "h-7 rounded-[4px] px-2 text-[13px] font-semibold"
                : "h-7 rounded-[4px] px-2.5 text-[13px] font-semibold max-[700px]:px-2"
            )}
          >
            {state.isActing ? (
              <LoadingIcon
                className={cn(
                  "animate-spin",
                  compact ? "size-3" : "size-4 max-[700px]:size-3.5"
                )}
              />
            ) : null}
            <span>{t(view.actionKey)}</span>
          </Button>
        </>
      ) : null}
    </div>
  );
}

function StandaloneAppUpdateStatus({
  isActing,
  openReleaseNotes,
  runPrimaryAction,
  showReleaseNotes,
  view
}: {
  isActing: boolean;
  openReleaseNotes(): Promise<void>;
  runPrimaryAction(): Promise<void>;
  showReleaseNotes: boolean;
  view: ReturnType<typeof useAppUpdateService>["state"]["view"];
}) {
  const { t } = useTranslation();
  const presentation = resolveStandaloneAppUpdateStatusPresentation(view);

  if (!presentation) {
    return null;
  }

  const title = t(presentation.titleKey, presentation.titleParams);
  if (presentation.kind === "status") {
    return (
      <span
        aria-label={title}
        className="inline-flex h-7 items-center gap-1.5 text-[13px] font-medium text-[var(--text-secondary)] [-webkit-app-region:no-drag]"
        role="status"
      >
        <LoadingIcon aria-hidden className="size-3.5 animate-spin" />
        <span>{title}</span>
      </span>
    );
  }

  const actionLabel = t(presentation.actionKey);
  const releaseNotesLabel = t("updates.releaseNotesAction");
  const actionIcon =
    presentation.actionKey === "updates.downloadAction" ? (
      <DownloadIcon aria-hidden className="size-3.5" />
    ) : (
      <RefreshIcon aria-hidden className="size-3.5" />
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`${title}: ${actionLabel}`}
          className="relative h-7 w-7 rounded-[6px] p-0 [-webkit-app-region:no-drag]"
          disabled={isActing}
          size="icon-sm"
          title={title}
          type="button"
          variant="chrome"
        >
          {isActing ? (
            <LoadingIcon aria-hidden className="size-3.5 animate-spin" />
          ) : (
            actionIcon
          )}
          <span
            aria-hidden
            className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--tutti-purple)] ring-2 ring-[var(--background)]"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 gap-3 p-3 [-webkit-app-region:no-drag]"
        side="bottom"
        sideOffset={8}
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--tutti-purple)_14%,transparent)] text-[var(--tutti-purple)]">
            {actionIcon}
          </span>
          <p className="min-w-0 pt-1 text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
            {title}
          </p>
        </div>
        <div className="flex items-center justify-end gap-1.5">
          {showReleaseNotes ? (
            <PopoverClose asChild>
              <Button
                disabled={isActing}
                onClick={() => {
                  void openReleaseNotes();
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                {releaseNotesLabel}
              </Button>
            </PopoverClose>
          ) : null}
          <PopoverClose asChild>
            <Button
              disabled={isActing}
              onClick={() => {
                void runPrimaryAction();
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              {actionLabel}
            </Button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RotatingUpdateIcon() {
  const [previousUrl, setPreviousUrl] = useState(updateIconUrl);
  const [currentUrl, setCurrentUrl] = useState(updateIconUrl);
  const [rolling, setRolling] = useState(false);

  useEffect(() => {
    let settleTimeout: number | null = null;
    const interval = window.setInterval(() => {
      setCurrentUrl((current) => {
        const next = current === updateIconUrl ? tuttiIconUrl : updateIconUrl;
        setPreviousUrl(current);
        setRolling(true);

        if (settleTimeout !== null) {
          window.clearTimeout(settleTimeout);
        }

        settleTimeout = window.setTimeout(() => {
          setRolling(false);
        }, 260);

        return next;
      });
    }, 3000);

    return () => {
      window.clearInterval(interval);
      if (settleTimeout !== null) {
        window.clearTimeout(settleTimeout);
      }
    };
  }, []);

  return (
    <span className="inline-flex h-7 w-5 shrink-0 items-center justify-center">
      <span className="relative inline-flex size-5 overflow-hidden [perspective:80px]">
        <img
          aria-hidden="true"
          alt=""
          className={cn(
            "absolute inset-0 size-5 object-contain [backface-visibility:hidden] [transform-origin:center_bottom] motion-reduce:transition-none",
            rolling
              ? "transition-[opacity,transform] duration-[260ms] ease-out"
              : "transition-none",
            rolling
              ? "opacity-0 [transform:rotateX(-88deg)]"
              : "opacity-100 [transform:rotateX(0deg)]"
          )}
          draggable={false}
          src={rolling ? previousUrl : currentUrl}
        />
        <img
          aria-hidden="true"
          alt=""
          className={cn(
            "absolute inset-0 size-5 object-contain [backface-visibility:hidden] [transform-origin:center_top] motion-reduce:transition-none",
            rolling
              ? "transition-[opacity,transform] duration-[260ms] ease-out"
              : "transition-none",
            rolling
              ? "opacity-100 [transform:rotateX(0deg)]"
              : "opacity-0 [transform:rotateX(88deg)]"
          )}
          draggable={false}
          src={currentUrl}
        />
      </span>
    </span>
  );
}
