import { type JSX } from "react";
import { useComposedInputValue } from "@tutti-os/ui-react-hooks";
import {
  Badge,
  Button,
  CloseIcon,
  FileCreateIcon,
  Input,
  ScrollArea,
  UnderlineTabs,
  cn
} from "@tutti-os/ui-system";
import type {
  IssueManagerIssueSummary,
  IssueManagerNodeState
} from "../../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";
import {
  formatIssueManagerDate,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import {
  issueManagerStatusFilters,
  type IssueManagerSidebarViewState
} from "./IssueManagerShellState.ts";
import { issueManagerStatusBadgeVariant } from "../status/IssueManagerStatusBadge.ts";

export function IssueManagerSidebarHeader({
  copy,
  issueSearchQuery,
  onCreateIssue,
  onIssueSearchUsage,
  onIssueSearchQueryChange
}: {
  copy: IssueManagerI18nRuntime;
  issueSearchQuery: string;
  onCreateIssue: () => void;
  onIssueSearchUsage: (value: string) => void;
  onIssueSearchQueryChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-2.5">
        <IssueManagerSearchField
          clearLabel={copy.t("actions.clearSearch")}
          placeholder={copy.t("labels.searchIssues")}
          value={issueSearchQuery}
          onChange={onIssueSearchQueryChange}
          onSearchUsage={onIssueSearchUsage}
        />
        <Button
          className="gap-2 px-3"
          size="dialog"
          type="button"
          variant="secondary"
          onClick={onCreateIssue}
        >
          <FileCreateIcon size={16} />
          {copy.t("actions.createIssue")}
        </Button>
      </div>
    </div>
  );
}

export function IssueManagerSidebarStatusTabs({
  copy,
  issueStatusFilter,
  statusCounts,
  onIssueStatusFilterChange
}: {
  copy: IssueManagerI18nRuntime;
  issueStatusFilter: IssueManagerNodeState["issueStatusFilter"];
  statusCounts: Record<(typeof issueManagerStatusFilters)[number], number>;
  onIssueStatusFilterChange: (
    value: IssueManagerNodeState["issueStatusFilter"]
  ) => void;
}): JSX.Element {
  return (
    <UnderlineTabs
      ariaLabel={copy.t("labels.status")}
      className="px-4"
      scrollLeftLabel={copy.t("labels.scrollStatusTabsLeft")}
      scrollRightLabel={copy.t("labels.scrollStatusTabsRight")}
      tabs={issueManagerStatusFilters.map((status) => ({
        count: statusCounts[status] ?? 0,
        label:
          status === "all"
            ? copy.t("labels.allStatus")
            : resolveIssueManagerStatusLabel(copy, status),
        value: status
      }))}
      value={issueStatusFilter}
      onValueChange={onIssueStatusFilterChange}
    />
  );
}

export function IssueManagerSidebarBody({
  copy,
  isNarrowLayout,
  selectedIssueId,
  sidebarViewState,
  onRetry,
  onSelectIssue
}: {
  copy: IssueManagerI18nRuntime;
  isNarrowLayout: boolean;
  selectedIssueId: string | null;
  sidebarViewState: IssueManagerSidebarViewState;
  onRetry: () => void;
  onSelectIssue: (issueId: string | null) => void;
}): JSX.Element {
  return (
    <ScrollArea
      scrollbarMode="native"
      className={cn("min-h-0", isNarrowLayout ? "flex-none" : "h-full flex-1")}
    >
      <div
        className={cn(
          "flex min-h-full flex-col gap-2.5 px-4 pt-1.5 pb-4",
          isNarrowLayout ? "min-h-0" : "h-full"
        )}
      >
        {sidebarViewState.kind === "loading" ? (
          <IssueManagerSidebarLoadingState isNarrowLayout={isNarrowLayout} />
        ) : sidebarViewState.kind === "error" ? (
          <IssueManagerSidebarErrorState
            isNarrowLayout={isNarrowLayout}
            retryLabel={sidebarViewState.retryLabel}
            title={sidebarViewState.title}
            onRetry={onRetry}
          />
        ) : sidebarViewState.kind === "empty" ? (
          <IssueManagerSidebarEmptyState
            body={sidebarViewState.body}
            isNarrowLayout={isNarrowLayout}
            title={sidebarViewState.title}
          />
        ) : (
          <IssueManagerSidebarIssueList
            copy={copy}
            isNarrowLayout={isNarrowLayout}
            issues={sidebarViewState.issues}
            selectedIssueId={selectedIssueId}
            onSelectIssue={onSelectIssue}
          />
        )}
      </div>
    </ScrollArea>
  );
}

export function IssueManagerSidebarStandalonePane({
  body,
  isNarrowLayout,
  kind,
  retryLabel,
  title,
  onRetry
}: {
  body?: string;
  isNarrowLayout: boolean;
  kind: "empty" | "error";
  retryLabel?: string;
  title: string;
  onRetry: () => void;
}): JSX.Element {
  if (kind === "error" && retryLabel) {
    return (
      <IssueManagerSidebarErrorState
        isNarrowLayout={isNarrowLayout}
        retryLabel={retryLabel}
        title={title}
        onRetry={onRetry}
      />
    );
  }

  return (
    <IssueManagerSidebarEmptyState
      body={body ?? ""}
      isNarrowLayout={isNarrowLayout}
      title={title}
    />
  );
}

function IssueManagerSearchField({
  clearLabel,
  onChange,
  onSearchUsage,
  placeholder,
  value
}: {
  clearLabel: string;
  onChange: (value: string) => void;
  onSearchUsage: (value: string) => void;
  placeholder: string;
  value: string;
}): JSX.Element {
  const searchInput = useComposedInputValue({ onCommit: onChange, value });

  return (
    <div
      className="relative min-w-0 flex-1"
      data-has-value={searchInput.value ? "true" : "false"}
    >
      <Input
        aria-label={placeholder}
        className={cn(
          "box-border h-8 min-h-8 rounded-md border-0 bg-[var(--transparency-block)] px-3 text-[13px] font-normal leading-normal text-[var(--text-primary)] shadow-none outline-none ring-0 transition-colors placeholder:text-[var(--text-placeholder)] hover:bg-[var(--transparency-hover)] focus:border-0 focus:bg-[var(--transparency-hover)] focus-visible:border-0 focus-visible:bg-[var(--transparency-hover)] focus-visible:ring-0 focus-visible:ring-offset-0 disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-disabled)] disabled:opacity-100",
          "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
          searchInput.value ? "pr-9" : "pr-3"
        )}
        placeholder={placeholder}
        type="search"
        value={searchInput.value}
        onBlur={(event) => {
          searchInput.onBlur(event);
          onSearchUsage(event.currentTarget.value);
        }}
        onChange={searchInput.onChange}
        onCompositionEnd={searchInput.onCompositionEnd}
        onCompositionStart={searchInput.onCompositionStart}
      />
      {searchInput.value ? (
        <button
          aria-label={clearLabel}
          className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border-0 bg-transparent p-0 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-secondary)] focus-visible:bg-[var(--transparency-hover)] focus-visible:text-[var(--text-secondary)] focus-visible:outline-none"
          type="button"
          onClick={searchInput.clearValue}
          onMouseDown={(event) => event.preventDefault()}
        >
          <CloseIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function IssueManagerSidebarIssueList({
  copy,
  isNarrowLayout,
  issues,
  selectedIssueId,
  onSelectIssue
}: {
  copy: IssueManagerI18nRuntime;
  isNarrowLayout: boolean;
  issues: readonly IssueManagerIssueSummary[];
  selectedIssueId: string | null;
  onSelectIssue: (issueId: string | null) => void;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex gap-2.5",
        isNarrowLayout
          ? "flex-row flex-nowrap items-start overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "flex-col"
      )}
    >
      {issues.map((issue) => (
        <IssueManagerSidebarItem
          copy={copy}
          isNarrowLayout={isNarrowLayout}
          issue={issue}
          key={issue.issueId}
          selected={selectedIssueId === issue.issueId}
          onSelect={onSelectIssue}
        />
      ))}
    </div>
  );
}

function IssueManagerSidebarItem({
  copy,
  isNarrowLayout,
  issue,
  onSelect,
  selected
}: {
  copy: IssueManagerI18nRuntime;
  isNarrowLayout: boolean;
  issue: IssueManagerIssueSummary;
  onSelect: (issueId: string | null) => void;
  selected: boolean;
}): JSX.Element {
  return (
    <button
      className={cn(
        "relative rounded-lg border px-3.5 py-3.5 text-left transition-colors",
        isNarrowLayout
          ? "h-24 max-h-24 min-h-24 w-[clamp(220px,58vw,320px)] flex-[0_0_clamp(220px,58vw,320px)] overflow-hidden"
          : "w-full",
        selected
          ? "border-[var(--border-1)] bg-[var(--background-fronted)]"
          : "border-[var(--border-1)] bg-transparent hover:bg-[var(--transparency-block)]"
      )}
      type="button"
      onClick={() => onSelect(issue.issueId)}
    >
      <Badge
        className="absolute top-3.5 right-3.5"
        variant={issueManagerStatusBadgeVariant(issue.status)}
      >
        {resolveIssueManagerStatusLabel(copy, issue.status)}
      </Badge>
      <div className="min-w-0 space-y-2">
        <p className="pr-28 text-[11px] leading-[1.55] text-[var(--text-secondary)]">
          {formatIssueManagerDate(issue.updatedAtUnix ?? issue.createdAtUnix)}
        </p>
        <p className="line-clamp-4 text-[13px] font-medium leading-[1.35rem] text-[var(--text-primary)]">
          {issue.title}
        </p>
      </div>
      <div className="mt-2 text-[11px] leading-[1.55] text-[var(--text-secondary)]">
        {copy.t("labels.taskCount", { count: issue.taskCount ?? 0 })}
      </div>
    </button>
  );
}

function IssueManagerSidebarLoadingState({
  isNarrowLayout
}: {
  isNarrowLayout: boolean;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "gap-2.5",
        isNarrowLayout ? "flex flex-row flex-nowrap overflow-x-hidden" : "grid"
      )}
    >
      {Array.from({ length: 4 }, (_, index) => (
        <div
          className={cn(
            "rounded-lg bg-transparent px-3.5 py-3.5",
            isNarrowLayout &&
              "h-24 max-h-24 min-h-24 w-[clamp(220px,58vw,320px)] flex-[0_0_clamp(220px,58vw,320px)]"
          )}
          key={index}
        >
          <div className="h-3.5 w-20 rounded-full bg-[var(--transparency-block)]" />
          <div className="mt-3 h-4 w-4/5 rounded-full bg-[var(--transparency-block)]" />
          <div className="mt-4 h-3.5 w-24 rounded-full bg-[var(--transparency-block)]" />
        </div>
      ))}
    </div>
  );
}

function IssueManagerSidebarEmptyState({
  isNarrowLayout,
  title,
  tone = "default"
}: {
  body: string;
  isNarrowLayout: boolean;
  title: string;
  tone?: "default" | "destructive";
}): JSX.Element {
  return (
    <div
      className={cn(
        "relative flex flex-1 flex-col items-center justify-center self-stretch overflow-hidden p-0 text-center",
        isNarrowLayout
          ? "h-24 max-h-24 min-h-24 w-full flex-[0_0_100%]"
          : "min-h-full"
      )}
    >
      <p
        className={cn(
          "max-w-sm text-[13px] leading-5 text-[var(--text-secondary)]",
          tone === "destructive"
            ? "text-[var(--state-danger)]"
            : "text-[var(--text-secondary)]"
        )}
      >
        {title}
      </p>
    </div>
  );
}

function IssueManagerSidebarErrorState({
  isNarrowLayout,
  retryLabel,
  title,
  onRetry
}: {
  isNarrowLayout: boolean;
  retryLabel: string;
  title: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div
      className={cn(
        "relative flex flex-1 flex-col items-center justify-center self-stretch overflow-hidden px-4 py-6 text-center",
        isNarrowLayout
          ? "h-24 max-h-24 min-h-24 w-full flex-[0_0_100%]"
          : "min-h-full"
      )}
    >
      <p className="text-[13px] font-semibold leading-5 text-[var(--state-danger)]">
        {title}
      </p>
      <Button
        className="mt-3"
        size="sm"
        type="button"
        variant="secondary"
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  );
}
