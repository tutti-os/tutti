import { useEffect, useMemo, useState } from "react";
import type * as React from "react";
import type {
  ExternalAgentImportResultResponse,
  ExternalAgentImportScanResponse,
  ExternalAgentImportSession,
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  Button,
  Checkbox,
  ChatIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FolderIcon,
  LoadingIcon,
  RefreshIcon,
  SearchIcon,
  SuccessFilledIcon,
  UploadIcon,
  formatTuttiShortDateTime
} from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { useTranslation } from "@renderer/i18n";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";
import {
  isExternalImportWizardBusy,
  shouldAllowExternalImportDialogOpenChange
} from "./externalAgentSessionImportWizardModel";

const externalImportProviderOptions: WorkspaceAgentProvider[] = [
  "codex",
  "claude-code"
];

type ExternalImportStep = "providers" | "select";

// Day windows surfaced as quick presets. -1 means "all available history".
const externalImportRangeDays = [7, 30, 90, -1] as const;
const externalImportDefaultDays = 30;

const externalImportListCheckboxClass =
  "focus-visible:!ring-0 focus-visible:border-[var(--border-1)] data-[state=checked]:focus-visible:border-[var(--text-primary)]";

const externalImportListItemClass =
  "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[8px] bg-[var(--transparency-block)] p-3 transition-colors hover:bg-[var(--transparency-hover)]";

type ExternalImportProjectGroup = {
  path: string;
  label: string;
  providers: WorkspaceAgentProvider[];
  sessions: ExternalAgentImportSession[];
};

export function ExternalAgentSessionImportWizard({
  initialProviders,
  onOpenChange,
  open,
  workspace
}: {
  initialProviders?: WorkspaceAgentProvider[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const [scan, setScan] = useState<ExternalAgentImportScanResponse | null>(
    null
  );
  const [result, setResult] =
    useState<ExternalAgentImportResultResponse | null>(null);
  const [step, setStep] = useState<ExternalImportStep>("providers");
  const [selectedProviders, setSelectedProviders] = useState<
    Set<WorkspaceAgentProvider>
  >(new Set(externalImportProviderOptions));
  const [days, setDays] = useState<number>(externalImportDefaultDays);
  const [search, setSearch] = useState("");
  // Sessions are selected by default; we only track explicit opt-outs so that
  // widening the day range or re-scanning keeps the user's deselections.
  const [deselectedSessionIds, setDeselectedSessionIds] = useState<Set<string>>(
    new Set()
  );
  const [registerProjects, setRegisterProjects] = useState(true);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerKey = useMemo(
    () => (initialProviders ?? []).join("\n"),
    [initialProviders]
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const providers = initialProviders?.length
      ? initialProviders
      : externalImportProviderOptions;
    setSelectedProviders(new Set(providers));
    setStep("providers");
    setScan(null);
    setError(null);
    setResult(null);
    setLoading(false);
    setImporting(false);
    setDays(externalImportDefaultDays);
    setSearch("");
    setDeselectedSessionIds(new Set());
    setRegisterProjects(true);
    return undefined;
  }, [initialProviders, open, providerKey]);

  const selectedProviderList = externalImportProviderOptions.filter(
    (provider) => selectedProviders.has(provider)
  );
  const groups = useMemo(
    () => externalImportGroupsFromScan(scan, t),
    [scan, t]
  );
  const filteredGroups = useMemo(
    () => filterExternalImportGroups(groups, search),
    [groups, search]
  );
  const allSessionIds = useMemo(
    () => (scan?.sessions ?? []).map((session) => session.id),
    [scan]
  );
  const selectedCount = useMemo(
    () => allSessionIds.filter((id) => !deselectedSessionIds.has(id)).length,
    [allSessionIds, deselectedSessionIds]
  );
  const canScan = selectedProviderList.length > 0 && !loading && !importing;
  const canImport = selectedCount > 0 && !loading && !importing;

  const toggleProvider = (
    provider: WorkspaceAgentProvider,
    checked: boolean
  ) => {
    setSelectedProviders((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(provider);
      } else {
        next.delete(provider);
      }
      return next;
    });
  };

  const setSessionsSelected = (ids: string[], selected: boolean) => {
    setDeselectedSessionIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  };

  const runScan = async (nextDays: number) => {
    setLoading(true);
    setError(null);
    try {
      const nextScan =
        await workspaceAgentActivityService.scanExternalSessionImports(
          workspace.id,
          { providers: selectedProviderList, days: nextDays }
        );
      setScan(nextScan);
      // Drop deselections for sessions that no longer exist in the new scan.
      const nextIds = new Set(nextScan.sessions.map((session) => session.id));
      setDeselectedSessionIds((current) => {
        const next = new Set<string>();
        for (const id of current) {
          if (nextIds.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
      setStep("select");
    } catch {
      setError(t("workspace.externalImport.scanFailed"));
      setStep("select");
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    if (!canScan) {
      return;
    }
    await runScan(days);
  };

  const handleSelectRange = async (nextDays: number) => {
    if (nextDays === days || loading || importing) {
      return;
    }
    setDays(nextDays);
    await runScan(nextDays);
  };

  const handleImport = async () => {
    if (!canImport || !scan) {
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const projects = externalImportSelectionProjects(
        scan.sessions,
        deselectedSessionIds
      );
      const nextResult =
        await workspaceAgentActivityService.importExternalSessions(
          workspace.id,
          {
            projects,
            registerUserProjects: registerProjects,
            importSessions: true
          }
        );
      setResult(nextResult);
    } catch {
      setError(t("workspace.externalImport.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const showSelectStep = step === "select" && !result && !error && !loading;

  // Scanning is quick, but importing can run for a while against a large
  // history. Dismissing the dialog does not cancel the in-flight request (the
  // import keeps running to completion on the backend either way), but an
  // accidental outside click/Escape here reads as "the import stopped" and
  // hides the progress/result UI for no reason. Block dismissal while a
  // request is in flight so the only way out is the explicit Cancel/Back
  // control (disabled while importing) or letting it finish.
  const blockDismissWhileBusy = (event: { preventDefault: () => void }) => {
    if (isExternalImportWizardBusy({ importing, loading })) {
      event.preventDefault();
    }
  };

  // Radix's built-in "X" close button (rendered by DialogContent via
  // showCloseButton) dismisses through DialogPrimitive.Close, a third path
  // that never fires onEscapeKeyDown/onInteractOutside above. Guard it here
  // at the source by wrapping the onOpenChange handed to <Dialog>, using the
  // same busy condition (see externalAgentSessionImportWizardModel.ts) so
  // all three dismiss paths agree. The explicit Cancel/Back/Done buttons
  // below call the raw onOpenChange prop directly and are unaffected;
  // Cancel/Back are already disabled while busy.
  const handleOpenChange = (nextOpen: boolean) => {
    if (
      shouldAllowExternalImportDialogOpenChange({
        importing,
        loading,
        nextOpen
      })
    ) {
      onOpenChange(nextOpen);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[min(640px,calc(100vh-32px))] flex-col gap-0 overflow-hidden bg-[var(--background-fronted)] p-0 sm:max-w-[640px]"
        onEscapeKeyDown={blockDismissWhileBusy}
        onInteractOutside={blockDismissWhileBusy}
        showCloseButton={!isExternalImportWizardBusy({ importing, loading })}
      >
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>
            {step === "select"
              ? t("workspace.externalImport.selectTitle")
              : t("workspace.externalImport.title")}
          </DialogTitle>
          <DialogDescription>
            {step === "select"
              ? t("workspace.externalImport.selectDescription")
              : t("workspace.externalImport.description")}
          </DialogDescription>
        </DialogHeader>
        {showSelectStep ? (
          <ImportSelectStep
            groups={filteredGroups}
            days={days}
            search={search}
            onSearchChange={setSearch}
            onSelectRange={(nextDays) => {
              void handleSelectRange(nextDays);
            }}
            deselectedSessionIds={deselectedSessionIds}
            selectedCount={selectedCount}
            totalCount={allSessionIds.length}
            registerProjects={registerProjects}
            onToggleRegisterProjects={setRegisterProjects}
            onToggleSessions={setSessionsSelected}
            disabled={importing}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <CenteredImportState
                icon={<LoadingIcon className="size-5 animate-spin" />}
                text={t("workspace.externalImport.scanning")}
              />
            ) : result ? (
              <ImportResultSummary result={result} />
            ) : error ? (
              <CenteredImportState
                icon={<RefreshIcon className="size-5" />}
                text={error}
              />
            ) : (
              <ProviderSelectionList
                providers={externalImportProviderOptions}
                selectedProviders={selectedProviders}
                onToggle={toggleProvider}
              />
            )}
          </div>
        )}
        <DialogFooter className="shrink-0 border-t border-[var(--border-1)] px-5 py-4">
          {result ? (
            <Button
              size="dialog"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              {t("workspace.externalImport.done")}
            </Button>
          ) : (
            <>
              <Button
                disabled={loading || importing}
                size="dialog"
                type="button"
                variant="ghost"
                onClick={() => {
                  if (step === "select") {
                    setStep("providers");
                    setError(null);
                    return;
                  }
                  onOpenChange(false);
                }}
              >
                {step === "select"
                  ? t("workspace.externalImport.back")
                  : t("common.cancel")}
              </Button>
              {step === "providers" ? (
                <Button
                  disabled={!canScan}
                  size="dialog"
                  type="button"
                  onClick={() => {
                    void handleScan();
                  }}
                >
                  <RefreshIcon className="size-4" />
                  {t("workspace.externalImport.scan")}
                </Button>
              ) : (
                <Button
                  disabled={!canImport}
                  size="dialog"
                  type="button"
                  onClick={() => {
                    void handleImport();
                  }}
                >
                  {importing ? (
                    <LoadingIcon className="size-4 animate-spin" />
                  ) : (
                    <UploadIcon className="size-4" />
                  )}
                  {importing
                    ? t("workspace.externalImport.importing")
                    : t("workspace.externalImport.import")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderSelectionList({
  onToggle,
  providers,
  selectedProviders
}: {
  onToggle: (provider: WorkspaceAgentProvider, checked: boolean) => void;
  providers: WorkspaceAgentProvider[];
  selectedProviders: Set<WorkspaceAgentProvider>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] leading-[1.4] text-[var(--text-secondary)]">
        {t("workspace.externalImport.providerDescription")}
      </p>
      <div className="flex flex-col gap-2">
        {providers.map((provider) => {
          const checked = selectedProviders.has(provider);
          const label = resolveWorkspaceAgentGuiLabel(provider);
          return (
            <label key={provider} className={externalImportListItemClass}>
              <Checkbox
                aria-label={t("workspace.externalImport.selectProvider", {
                  label
                })}
                checked={checked}
                className={externalImportListCheckboxClass}
                onCheckedChange={(value) => onToggle(provider, value === true)}
              />
              <span className="min-w-0 text-[13px] font-semibold text-[var(--text-primary)]">
                {label}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ImportSelectStep({
  days,
  deselectedSessionIds,
  disabled,
  groups,
  onSearchChange,
  onSelectRange,
  onToggleRegisterProjects,
  onToggleSessions,
  registerProjects,
  search,
  selectedCount,
  totalCount
}: {
  days: number;
  deselectedSessionIds: Set<string>;
  disabled: boolean;
  groups: ExternalImportProjectGroup[];
  onSearchChange: (value: string) => void;
  onSelectRange: (days: number) => void;
  onToggleRegisterProjects: (checked: boolean) => void;
  onToggleSessions: (ids: string[], selected: boolean) => void;
  registerProjects: boolean;
  search: string;
  selectedCount: number;
  totalCount: number;
}) {
  const { t } = useTranslation();
  const visibleIds = useMemo(
    () =>
      groups.flatMap((group) => group.sessions.map((session) => session.id)),
    [groups]
  );
  const allVisibleSelected =
    visibleIds.length > 0 &&
    visibleIds.every((id) => !deselectedSessionIds.has(id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-5 pb-3 pt-4">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[12px] text-[var(--text-secondary)]">
            {t("workspace.externalImport.rangeLabel")}
          </span>
          {externalImportRangeDays.map((value) => (
            <button
              key={value}
              type="button"
              disabled={disabled}
              onClick={() => onSelectRange(value)}
              className={`rounded-[6px] px-2.5 py-1 text-[12px] transition-colors ${
                days === value
                  ? "bg-[var(--text-primary)] text-[var(--text-inverted)]"
                  : "bg-[var(--transparency-block)] text-[var(--text-secondary)] hover:bg-[var(--transparency-hover)]"
              }`}
            >
              {externalImportRangeLabel(value, t)}
            </button>
          ))}
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-placeholder)]" />
          <input
            type="text"
            value={search}
            disabled={disabled}
            placeholder={t("workspace.externalImport.searchPlaceholder")}
            onChange={(event) => onSearchChange(event.target.value)}
            className="h-8 w-full min-w-0 appearance-none rounded-md border border-transparent bg-[var(--transparency-block)] pl-9 pr-3 text-[13px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-placeholder)] hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)]"
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <Checkbox
              aria-label={t("workspace.externalImport.selectAll")}
              checked={allVisibleSelected}
              disabled={disabled || visibleIds.length === 0}
              className={externalImportListCheckboxClass}
              onCheckedChange={(value) =>
                onToggleSessions(visibleIds, value === true)
              }
            />
            {t("workspace.externalImport.selectAll")}
          </label>
          <span className="text-[12px] text-[var(--text-secondary)]">
            {t("workspace.externalImport.selectedCount", {
              selected: selectedCount,
              total: totalCount
            })}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        {groups.length === 0 ? (
          <CenteredImportState
            icon={<FolderIcon className="size-5" />}
            text={
              totalCount === 0
                ? t("workspace.externalImport.empty")
                : t("workspace.externalImport.noResults")
            }
          />
        ) : (
          <div className="flex flex-col gap-3 pb-2">
            {groups.map((group) => (
              <ImportProjectGroup
                key={group.path}
                group={group}
                deselectedSessionIds={deselectedSessionIds}
                disabled={disabled}
                onToggleSessions={onToggleSessions}
              />
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-[var(--border-1)] px-5 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <Checkbox
            aria-label={t("workspace.externalImport.registerProjects")}
            checked={registerProjects}
            disabled={disabled}
            className={externalImportListCheckboxClass}
            onCheckedChange={(value) =>
              onToggleRegisterProjects(value === true)
            }
          />
          {t("workspace.externalImport.registerProjects")}
        </label>
      </div>
    </div>
  );
}

function ImportProjectGroup({
  deselectedSessionIds,
  disabled,
  group,
  onToggleSessions
}: {
  deselectedSessionIds: Set<string>;
  disabled: boolean;
  group: ExternalImportProjectGroup;
  onToggleSessions: (ids: string[], selected: boolean) => void;
}) {
  const { t } = useTranslation();
  const groupIds = group.sessions.map((session) => session.id);
  const groupSelectedCount = groupIds.filter(
    (id) => !deselectedSessionIds.has(id)
  ).length;
  const allSelected =
    groupIds.length > 0 && groupSelectedCount === groupIds.length;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-center gap-2.5 rounded-[6px] px-1 py-1.5">
        <Checkbox
          aria-label={t("workspace.externalImport.selectProjectGroup", {
            label: group.label
          })}
          checked={allSelected}
          disabled={disabled}
          className={externalImportListCheckboxClass}
          onCheckedChange={(value) =>
            onToggleSessions(groupIds, value === true)
          }
        />
        <FolderIcon className="size-4 shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-primary)]">
          {group.label}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
          {groupSelectedCount}/{groupIds.length}
        </span>
      </label>
      <div className="ml-3 flex flex-col gap-1 border-l border-[var(--border-1)] pl-3">
        {group.sessions.map((session) => {
          const checked = !deselectedSessionIds.has(session.id);
          return (
            <label
              key={session.id}
              className="grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[6px] px-1 py-1.5 transition-colors hover:bg-[var(--transparency-hover)]"
            >
              <Checkbox
                aria-label={t("workspace.externalImport.selectSession", {
                  title: session.title
                })}
                checked={checked}
                disabled={disabled}
                className={externalImportListCheckboxClass}
                onCheckedChange={(value) =>
                  onToggleSessions([session.id], value === true)
                }
              />
              <ChatIcon className="size-3.5 shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 truncate text-[13px] text-[var(--text-primary)]">
                {session.title}
              </span>
              <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
                {externalImportSessionMeta(session, t)}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function externalImportRangeLabel(
  value: number,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (value) {
    case 7:
      return t("workspace.externalImport.range7");
    case 30:
      return t("workspace.externalImport.range30");
    case 90:
      return t("workspace.externalImport.range90");
    default:
      return t("workspace.externalImport.rangeAll");
  }
}

function externalImportSessionMeta(
  session: ExternalAgentImportSession,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const messages = t("workspace.externalImport.sessionMessages", {
    count: session.messageCount
  });
  if (session.lastUpdatedAtUnixMs) {
    return `${formatTuttiShortDateTime(session.lastUpdatedAtUnixMs)} · ${messages}`;
  }
  return messages;
}

function externalImportGroupsFromScan(
  scan: ExternalAgentImportScanResponse | null,
  t: ReturnType<typeof useTranslation>["t"]
): ExternalImportProjectGroup[] {
  if (!scan) {
    return [];
  }
  const labelByPath = new Map(
    scan.projects.map((project) => [project.path, project.label])
  );
  const groupByPath = new Map<string, ExternalImportProjectGroup>();
  for (const session of scan.sessions) {
    const path = session.projectPath;
    let group = groupByPath.get(path);
    if (!group) {
      group = {
        path,
        label:
          labelByPath.get(path) ?? externalImportProjectLabelFallback(path, t),
        providers: [],
        sessions: []
      };
      groupByPath.set(path, group);
    }
    if (!group.providers.includes(session.provider)) {
      group.providers.push(session.provider);
    }
    group.sessions.push(session);
  }
  return [...groupByPath.values()].sort(
    (left, right) =>
      externalImportGroupRecency(right) - externalImportGroupRecency(left)
  );
}

function externalImportGroupRecency(group: ExternalImportProjectGroup): number {
  return group.sessions.reduce(
    (latest, session) => Math.max(latest, session.lastUpdatedAtUnixMs ?? 0),
    0
  );
}

function externalImportProjectLabelFallback(
  path: string,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const base = trimmed.split(/[/\\]/).pop();
  return base && base.length > 0
    ? base
    : t("workspace.externalImport.projectOptionTitle", { count: 1 });
}

function filterExternalImportGroups(
  groups: ExternalImportProjectGroup[],
  search: string
): ExternalImportProjectGroup[] {
  const query = search.trim().toLowerCase();
  if (!query) {
    return groups;
  }
  const result: ExternalImportProjectGroup[] = [];
  for (const group of groups) {
    const labelMatch =
      group.label.toLowerCase().includes(query) ||
      group.path.toLowerCase().includes(query);
    const sessions = labelMatch
      ? group.sessions
      : group.sessions.filter((session) =>
          session.title.toLowerCase().includes(query)
        );
    if (sessions.length > 0) {
      result.push({ ...group, sessions });
    }
  }
  return result;
}

function externalImportSelectionProjects(
  sessions: ExternalAgentImportSession[],
  deselectedSessionIds: Set<string>
): {
  path: string;
  providers?: WorkspaceAgentProvider[];
  sessionIds?: string[];
}[] {
  const byPath = new Map<
    string,
    {
      path: string;
      providers: Set<WorkspaceAgentProvider>;
      sessionIds: string[];
    }
  >();
  for (const session of sessions) {
    if (deselectedSessionIds.has(session.id)) {
      continue;
    }
    let entry = byPath.get(session.projectPath);
    if (!entry) {
      entry = {
        path: session.projectPath,
        providers: new Set(),
        sessionIds: []
      };
      byPath.set(session.projectPath, entry);
    }
    entry.providers.add(session.provider);
    entry.sessionIds.push(session.id);
  }
  return [...byPath.values()].map((entry) => ({
    path: entry.path,
    providers: [...entry.providers],
    sessionIds: entry.sessionIds
  }));
}

function ImportResultSummary({
  result
}: {
  result: ExternalAgentImportResultResponse;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <CenteredImportState
        icon={
          <SuccessFilledIcon className="size-7 text-[var(--tutti-purple)]" />
        }
        text={t("workspace.externalImport.result", {
          messages: result.importedMessages,
          projects: result.importedProjects,
          sessions: result.importedSessions
        })}
      />
      {result.errors.length > 0 ? (
        <div className="rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] p-3">
          <strong className="text-[12px] font-semibold text-[var(--text-primary)]">
            {t("workspace.externalImport.errors")}
          </strong>
          <ul className="mt-2 flex flex-col gap-1 p-0 text-[12px] text-[var(--text-secondary)]">
            {result.errors.map((item, index) => (
              <li key={`${item.sourcePath ?? "error"}-${index}`}>
                {item.sourcePath ? `${item.sourcePath}: ` : ""}
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CenteredImportState({
  icon,
  text
}: {
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-center text-[13px] text-[var(--text-secondary)]">
      <div className="text-[var(--text-primary)]">{icon}</div>
      <p className="m-0 max-w-[360px] leading-[1.4]">{text}</p>
    </div>
  );
}
