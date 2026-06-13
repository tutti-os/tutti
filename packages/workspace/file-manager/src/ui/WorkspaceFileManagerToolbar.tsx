import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Button,
  ChevronDownIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  LoadingIcon,
  RefreshIcon,
  ViewGridLinedIcon,
  ViewListLinedIcon,
  cn
} from "@tutti-os/ui-system";
import { useState, type ReactElement } from "react";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerArrangeMode } from "./workspaceFileManagerArrangeMode.ts";
import type { WorkspaceFileManagerLayoutMode } from "./workspaceFileManagerLayoutMode.ts";

export function WorkspaceFileManagerToolbar({
  breadcrumbs,
  canGoBack,
  canGoForward,
  copy,
  currentDirectoryPath,
  isBusy,
  isLoading,
  isMutating,
  arrangeMode,
  layoutMode,
  onGoBack,
  onGoForward,
  onArrangeModeChange,
  onLayoutModeChange,
  onLoadDirectory,
  onRefresh
}: {
  breadcrumbs: Array<{ label: string; path: string }>;
  canGoBack: boolean;
  canGoForward: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  currentDirectoryPath: string;
  isBusy: boolean;
  isLoading: boolean;
  isMutating: boolean;
  arrangeMode: WorkspaceFileManagerArrangeMode;
  layoutMode: WorkspaceFileManagerLayoutMode;
  onGoBack: () => void;
  onGoForward: () => void;
  onArrangeModeChange: (arrangeMode: WorkspaceFileManagerArrangeMode) => void;
  onLayoutModeChange: (layoutMode: WorkspaceFileManagerLayoutMode) => void;
  onLoadDirectory: (path: string) => void;
  onRefresh: () => void;
}): ReactElement {
  const [refreshAnimationKey, setRefreshAnimationKey] = useState(0);

  const handleRefresh = (): void => {
    setRefreshAnimationKey((currentKey) => currentKey + 1);
    onRefresh();
  };

  return (
    <header className="@max-[600px]/workspace-file-manager:flex-nowrap flex h-10 min-h-10 w-full min-w-0 items-center gap-2 border-b border-[var(--border-1)] px-2 py-1">
      <ToolbarIconButton
        ariaLabel={copy.t("backLabel")}
        disabled={!canGoBack || isLoading || isBusy}
        title={copy.t("backLabel")}
        onClick={onGoBack}
      >
        <ArrowLeftIcon className="size-4" />
      </ToolbarIconButton>
      <ToolbarIconButton
        ariaLabel={copy.t("forwardLabel")}
        disabled={!canGoForward || isLoading || isBusy}
        title={copy.t("forwardLabel")}
        onClick={onGoForward}
      >
        <ArrowRightIcon className="size-4" />
      </ToolbarIconButton>
      <nav
        aria-label={currentDirectoryPath}
        className="@max-[600px]/workspace-file-manager:flex-auto flex min-w-0 flex-1 overflow-hidden pr-2"
        data-workspace-file-manager-path=""
      >
        <ol className="flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden">
          {breadcrumbs.map((crumb, index) => (
            <BreadcrumbButton
              key={crumb.path}
              active={index === breadcrumbs.length - 1}
              label={crumb.label}
              showSeparator={index > 0}
              onClick={() => {
                onLoadDirectory(crumb.path);
              }}
            />
          ))}
        </ol>
      </nav>
      <div className="@max-[600px]/workspace-file-manager:justify-end flex flex-none items-center gap-1.5">
        <LayoutModeToggle
          arrangeMode={arrangeMode}
          copy={copy}
          layoutMode={layoutMode}
          onArrangeModeChange={onArrangeModeChange}
          onLayoutModeChange={onLayoutModeChange}
        />
        <ToolbarActionButton
          disabled={isLoading || isMutating || isBusy}
          onClick={handleRefresh}
        >
          {isLoading ? (
            <LoadingIcon className="size-4 animate-spin" />
          ) : (
            <RefreshIcon
              key={refreshAnimationKey}
              className={cn(
                "size-4",
                refreshAnimationKey > 0 &&
                  "motion-safe:animate-[spin_520ms_cubic-bezier(0.4,0,0.2,1)_1_reverse]"
              )}
            />
          )}
          <span className="@max-[600px]/workspace-file-manager:hidden">
            {copy.t("refreshLabel")}
          </span>
        </ToolbarActionButton>
      </div>
    </header>
  );
}

function LayoutModeToggle({
  arrangeMode,
  copy,
  layoutMode,
  onArrangeModeChange,
  onLayoutModeChange
}: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  copy: WorkspaceFileManagerI18nRuntime;
  layoutMode: WorkspaceFileManagerLayoutMode;
  onArrangeModeChange: (arrangeMode: WorkspaceFileManagerArrangeMode) => void;
  onLayoutModeChange: (layoutMode: WorkspaceFileManagerLayoutMode) => void;
}): ReactElement {
  const arrangeOptions: Array<{
    label: string;
    mode: WorkspaceFileManagerArrangeMode;
  }> = [
    { label: copy.t("arrangeNoneLabel"), mode: "none" },
    { label: copy.t("nameLabel"), mode: "name" },
    { label: copy.t("arrangeKindLabel"), mode: "kind" },
    { label: copy.t("arrangeApplicationLabel"), mode: "application" },
    { label: copy.t("arrangeLastOpenedLabel"), mode: "lastOpened" },
    { label: copy.t("arrangeDateAddedLabel"), mode: "dateAdded" },
    { label: copy.t("modifiedLabel"), mode: "modified" },
    { label: copy.t("arrangeCreatedLabel"), mode: "created" },
    { label: copy.t("sizeLabel"), mode: "size" },
    { label: copy.t("arrangeTagsLabel"), mode: "tags" }
  ];

  return (
    <div
      className="flex items-center rounded-md border border-[var(--border-1)] bg-[var(--transparency-block)] p-0.5"
      role="group"
    >
      <LayoutModeButton
        active={layoutMode === "icon"}
        ariaLabel={copy.t("layoutIconViewLabel")}
        onClick={() => {
          onLayoutModeChange("icon");
        }}
      >
        <ViewGridLinedIcon className="size-4" />
      </LayoutModeButton>
      <LayoutModeButton
        active={layoutMode === "list"}
        ariaLabel={copy.t("layoutListViewLabel")}
        onClick={() => {
          onLayoutModeChange("list");
        }}
      >
        <ViewListLinedIcon className="size-4" />
      </LayoutModeButton>
      <span className="mx-0.5 h-4 w-px bg-[var(--border-1)]" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={copy.t("arrangeMenuLabel")}
            className="size-6 min-w-6 rounded-[4px] p-0 text-[var(--text-secondary)] data-[state=open]:bg-[var(--background-fronted)] data-[state=open]:text-[var(--text-primary)] data-[state=open]:shadow-sm"
            size="icon-sm"
            title={copy.t("arrangeMenuLabel")}
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[236px] px-1 py-1"
          sideOffset={7}
        >
          <DropdownMenuRadioGroup
            value={arrangeMode}
            onValueChange={(nextMode) => {
              onArrangeModeChange(nextMode as WorkspaceFileManagerArrangeMode);
            }}
          >
            {arrangeOptions.map((option, index) => (
              <div key={option.mode}>
                {index === 1 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuRadioItem
                  className="h-8 text-sm font-normal"
                  value={option.mode}
                >
                  {option.label}
                </DropdownMenuRadioItem>
              </div>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function LayoutModeButton({
  active,
  ariaLabel,
  children,
  onClick
}: {
  active: boolean;
  ariaLabel: string;
  children: ReactElement;
  onClick: () => void;
}): ReactElement {
  return (
    <Button
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        "size-6 min-w-6 rounded-[4px] p-0 text-text-secondary",
        active &&
          "!bg-background-fronted text-foreground hover:!bg-background-fronted"
      )}
      size="icon-sm"
      title={ariaLabel}
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ToolbarIconButton({
  ariaLabel,
  children,
  disabled,
  onClick,
  title
}: {
  ariaLabel: string;
  children: ReactElement;
  disabled: boolean;
  onClick: () => void;
  title: string;
}): ReactElement {
  return (
    <Button
      aria-label={ariaLabel}
      className="size-7 min-w-7 rounded-sm p-0 text-[var(--text-primary)]"
      disabled={disabled}
      size="icon-sm"
      title={title}
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ToolbarActionButton({
  children,
  disabled,
  onClick
}: {
  children: ReactElement | ReactElement[] | string;
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <Button
      className="@max-[600px]/workspace-file-manager:size-7 @max-[600px]/workspace-file-manager:min-w-7 @max-[600px]/workspace-file-manager:px-0 cursor-pointer"
      disabled={disabled}
      size="sm"
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function BreadcrumbButton({
  active,
  label,
  onClick,
  showSeparator
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  showSeparator: boolean;
}): ReactElement {
  return (
    <li className="flex min-w-0 items-center gap-2">
      {showSeparator ? (
        <span className="flex-none text-[var(--text-tertiary)]">/</span>
      ) : null}
      <button
        className={cn(
          "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent text-sm font-normal transition-colors",
          active
            ? "font-semibold text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        )}
        type="button"
        onClick={onClick}
      >
        {label}
      </button>
    </li>
  );
}
