import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Button,
  ChevronDownIcon,
  CloseIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  LoadingIcon,
  RefreshIcon,
  SearchIcon,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  ViewGridLinedIcon,
  ViewListLinedIcon,
  cn
} from "@tutti-os/ui-system";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerArrangeMode } from "./workspaceFileManagerArrangeMode.ts";
import type { WorkspaceFileManagerLayoutMode } from "./workspaceFileManagerLayoutMode.ts";

export function WorkspaceFileManagerToolbar({
  breadcrumbs,
  canSearch,
  canGoBack,
  canGoForward,
  copy,
  currentDirectoryPath,
  isBusy,
  isLoading,
  isMutating,
  isSearching,
  arrangeMode,
  layoutMode,
  searchQuery,
  onGoBack,
  onGoForward,
  onArrangeModeChange,
  onLayoutModeChange,
  onLoadDirectory,
  onRefresh,
  onSearchClear,
  onSearchQueryChange
}: {
  breadcrumbs: Array<{ label: string; path: string }>;
  canSearch: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  currentDirectoryPath: string;
  isBusy: boolean;
  isLoading: boolean;
  isMutating: boolean;
  isSearching: boolean;
  arrangeMode: WorkspaceFileManagerArrangeMode;
  layoutMode: WorkspaceFileManagerLayoutMode;
  searchQuery: string;
  onGoBack: () => void;
  onGoForward: () => void;
  onArrangeModeChange: (arrangeMode: WorkspaceFileManagerArrangeMode) => void;
  onLayoutModeChange: (layoutMode: WorkspaceFileManagerLayoutMode) => void;
  onLoadDirectory: (path: string) => void;
  onRefresh: () => void;
  onSearchClear: () => void;
  onSearchQueryChange: (query: string) => void;
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
        <WorkspaceFileManagerToolbarSearch
          canSearch={canSearch}
          copy={copy}
          isSearching={isSearching}
          searchQuery={searchQuery}
          onClear={onSearchClear}
          onSearchQueryChange={onSearchQueryChange}
        />
      </div>
    </header>
  );
}

function WorkspaceFileManagerToolbarSearch({
  canSearch,
  copy,
  isSearching,
  searchQuery,
  onClear,
  onSearchQueryChange
}: {
  canSearch: boolean;
  copy: WorkspaceFileManagerI18nRuntime;
  isSearching: boolean;
  searchQuery: string;
  onClear: () => void;
  onSearchQueryChange: (query: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(searchQuery.trim().length > 0);
  const [inputValue, setInputValue] = useState(searchQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const active = expanded || searchQuery.trim().length > 0;

  useEffect(() => {
    if (searchQuery.trim().length > 0) {
      setExpanded(true);
    }
  }, [searchQuery]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    inputRef.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (isComposingRef.current) {
      return;
    }
    setInputValue(searchQuery);
  }, [searchQuery]);

  const commitInputValue = (value: string): void => {
    setInputValue(value);
    onSearchQueryChange(value);
  };

  const handleClear = (): void => {
    isComposingRef.current = false;
    setInputValue("");
    onClear();
    setExpanded(false);
  };

  if (!active) {
    return (
      <ToolbarIconButton
        ariaLabel={copy.t("searchPlaceholder")}
        disabled={!canSearch}
        title={copy.t("searchPlaceholder")}
        onClick={() => {
          setExpanded(true);
        }}
      >
        <SearchIcon className="size-4" />
      </ToolbarIconButton>
    );
  }

  return (
    <div
      className={cn(
        "relative h-7 w-[min(220px,34vw)] flex-none overflow-hidden rounded-md bg-[var(--transparency-block)] transition-[width,opacity,background-color] duration-200 ease-out",
        "@max-[600px]/workspace-file-manager:w-[min(170px,42vw)]",
        !canSearch && "opacity-60"
      )}
    >
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
      <Input
        aria-label={copy.t("searchPlaceholder")}
        className="h-full border-0 bg-transparent pr-8 pl-8 text-sm shadow-none focus-visible:ring-0"
        disabled={!canSearch}
        placeholder={copy.t("searchPlaceholder")}
        ref={inputRef}
        value={inputValue}
        onBlur={(event) => {
          commitInputValue(event.currentTarget.value);
        }}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          if (isComposingRef.current) {
            setInputValue(nextValue);
            return;
          }
          commitInputValue(nextValue);
        }}
        onCompositionEnd={(event) => {
          isComposingRef.current = false;
          commitInputValue(event.currentTarget.value);
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") {
            return;
          }
          if (isComposingRef.current || event.nativeEvent.isComposing) {
            return;
          }
          event.preventDefault();
          handleClear();
        }}
      />
      <button
        aria-label={copy.t("clearSearchLabel")}
        className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)]"
        type="button"
        onClick={handleClear}
      >
        {isSearching ? (
          <LoadingIcon className="size-3 animate-spin" />
        ) : (
          <CloseIcon className="size-3" />
        )}
      </button>
    </div>
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
    { label: copy.t("sizeLabel"), mode: "size" }
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex items-center rounded-md border border-[var(--border-1)] bg-[var(--transparency-block)] p-0.5"
        role="group"
      >
        <LayoutModeButton
          active={layoutMode === "icon"}
          ariaLabel={copy.t("layoutIconViewLabel")}
          tooltipLabel={copy.t("layoutIconViewTooltipLabel")}
          onClick={() => {
            onLayoutModeChange("icon");
          }}
        >
          <ViewGridLinedIcon className="size-4" />
        </LayoutModeButton>
        <LayoutModeButton
          active={layoutMode === "list"}
          ariaLabel={copy.t("layoutListViewLabel")}
          tooltipLabel={copy.t("layoutListViewTooltipLabel")}
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
                onArrangeModeChange(
                  nextMode as WorkspaceFileManagerArrangeMode
                );
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
    </TooltipProvider>
  );
}

function LayoutModeButton({
  active,
  ariaLabel,
  children,
  onClick,
  tooltipLabel
}: {
  active: boolean;
  ariaLabel: string;
  children: ReactElement;
  onClick: () => void;
  tooltipLabel: string;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={ariaLabel}
          aria-pressed={active}
          className={cn(
            "size-6 min-w-6 rounded-[4px] p-0 text-text-secondary",
            active &&
              "!bg-background-fronted text-foreground hover:!bg-background-fronted"
          )}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltipLabel}</TooltipContent>
    </Tooltip>
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
