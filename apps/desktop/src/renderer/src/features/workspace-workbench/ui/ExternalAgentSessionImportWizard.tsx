import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ExternalAgentImportResultResponse,
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
  UploadIcon,
  formatTuttiShortDateTime
} from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { useTranslation } from "@renderer/i18n";
import {
  externalImportGroupsFromScan,
  externalImportRequestSource,
  externalImportScanRequest,
  externalImportScanSource,
  externalImportScanStateReducer,
  externalImportSelectionProjects,
  externalImportUsableScan,
  filterExternalImportGroups,
  isExternalImportArchiveMode,
  isExternalImportWizardBusy,
  shouldAllowExternalImportDialogOpenChange,
  type ExternalImportProjectGroup
} from "./externalAgentSessionImportWizardModel";
import { ExternalAgentSessionImportSourceStep } from "./ExternalAgentSessionImportSourceStep";
import {
  CenteredExternalAgentSessionImportState,
  ExternalAgentSessionImportResultSummary
} from "./ExternalAgentSessionImportStatus";

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
  const [scanState, dispatchScanState] = useReducer(
    externalImportScanStateReducer,
    null
  );
  const [result, setResult] =
    useState<ExternalAgentImportResultResponse | null>(null);
  const [step, setStep] = useState<ExternalImportStep>("providers");
  const [selectedProviders, setSelectedProviders] = useState<
    Set<WorkspaceAgentProvider>
  >(new Set(externalImportProviderOptions));
  const [days, setDays] = useState<number>(externalImportDefaultDays);
  const [archivePath, setArchivePath] = useState<string | null>(null);
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
  // Requests are not aborted on close, so a
  // scan started in a previous dialog lifecycle can settle after the wizard
  // was reset or a newer scan began. Every reset and every new scan bumps this
  // generation; in-flight continuations compare against it before applying
  // their results so a stale scan can never overwrite newer wizard state.
  const scanGeneration = useRef(0);

  useEffect(() => {
    scanGeneration.current += 1;
    if (!open) {
      return undefined;
    }
    const providers = initialProviders?.length
      ? initialProviders
      : externalImportProviderOptions;
    setSelectedProviders(new Set(providers));
    setStep("providers");
    dispatchScanState({ type: "source-changed" });
    setError(null);
    setResult(null);
    setLoading(false);
    setImporting(false);
    setDays(externalImportDefaultDays);
    setArchivePath(null);
    setSearch("");
    setDeselectedSessionIds(new Set());
    setRegisterProjects(true);
    return undefined;
  }, [initialProviders, open, providerKey]);

  const selectedProviderList = externalImportProviderOptions.filter(
    (provider) => selectedProviders.has(provider)
  );
  const currentScanSource = externalImportScanSource({
    archivePath,
    days,
    providers: selectedProviderList
  });
  const scan = externalImportUsableScan(scanState, currentScanSource);
  const archiveMode = isExternalImportArchiveMode(archivePath);
  const groups = useMemo(
    () =>
      externalImportGroupsFromScan(
        scan,
        (path) => externalImportProjectLabelFallback(path, t),
        archiveMode
          ? t("workspace.externalImport.archiveGroupLabel")
          : undefined
      ),
    [archiveMode, scan, t]
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

  const runScan = async (nextDays: number, nextArchivePath: string | null) => {
    const generation = ++scanGeneration.current;
    const source = externalImportScanSource({
      archivePath: nextArchivePath,
      days: nextDays,
      providers: selectedProviderList
    });
    dispatchScanState({ type: "scan-started" });
    setLoading(true);
    setError(null);
    try {
      const nextScan =
        await workspaceAgentActivityService.scanExternalSessionImports(
          workspace.id,
          externalImportScanRequest(source)
        );
      if (generation !== scanGeneration.current) {
        return;
      }
      dispatchScanState({
        type: "scan-succeeded",
        response: nextScan,
        source
      });
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
      if (generation !== scanGeneration.current) {
        return;
      }
      dispatchScanState({ type: "scan-failed" });
      setError(
        t(
          nextArchivePath
            ? "workspace.externalImport.archiveScanFailed"
            : "workspace.externalImport.scanFailed"
        )
      );
      setStep("select");
    } finally {
      if (generation === scanGeneration.current) {
        setLoading(false);
      }
    }
  };

  const handleScan = async () => {
    if (!canScan) {
      return;
    }
    setArchivePath(null);
    await runScan(days, null);
  };

  const handleSelectArchive = async () => {
    if (loading || importing) {
      return;
    }
    dispatchScanState({ type: "source-changed" });
    setError(null);
    // The dialog stays dismissable while the system file picker is open, so
    // its continuation must not touch a wizard that was reset in the interim.
    const generation = scanGeneration.current;
    try {
      const nextArchivePath =
        await workspaceAgentActivityService.selectExternalSessionImportArchive();
      if (generation !== scanGeneration.current || !nextArchivePath) {
        return;
      }
      setArchivePath(nextArchivePath);
      setDays(-1);
      await runScan(-1, nextArchivePath);
    } catch {
      if (generation !== scanGeneration.current) {
        return;
      }
      // Stay on the providers step: no scan ran, so the select-step chrome
      // (title, Import/Back footer) would not match the actual wizard state.
      dispatchScanState({ type: "scan-failed" });
      setError(t("workspace.externalImport.archivePickFailed"));
    }
  };

  const handleSelectRange = async (nextDays: number) => {
    if (nextDays === days || loading || importing) {
      return;
    }
    setDays(nextDays);
    await runScan(nextDays, archivePath);
  };

  const handleImport = async () => {
    if (!canImport || !scan || !scanState) {
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
            ...externalImportRequestSource(
              scanState.source.kind === "archive"
                ? scanState.source.archivePath
                : null,
              registerProjects
            ),
            projects,
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
        aria-busy={loading || importing}
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
              ? t(
                  archiveMode
                    ? "workspace.externalImport.archiveSelectDescription"
                    : "workspace.externalImport.selectDescription"
                )
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
            archiveMode={archiveMode}
            showProjectRegistration={!archiveMode}
            showRange={!archiveMode}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <CenteredExternalAgentSessionImportState
                ariaLive="polite"
                icon={<LoadingIcon className="size-5 animate-spin" />}
                role="status"
                text={t(
                  archiveMode
                    ? "workspace.externalImport.archiveScanning"
                    : "workspace.externalImport.scanning"
                )}
              />
            ) : result ? (
              <ExternalAgentSessionImportResultSummary
                archive={archiveMode}
                result={result}
              />
            ) : error && step === "select" ? (
              <CenteredExternalAgentSessionImportState
                ariaLive="assertive"
                icon={<RefreshIcon className="size-5" />}
                role="alert"
                text={error}
              />
            ) : (
              <>
                {error ? (
                  // Picker failures surface inline so the provider and
                  // archive controls stay reachable for an immediate retry.
                  <p
                    aria-live="assertive"
                    className="mb-3 rounded-[8px] border border-[var(--border-1)] bg-[var(--transparency-block)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}
                <ExternalAgentSessionImportSourceStep
                  disabled={loading || importing}
                  providers={externalImportProviderOptions}
                  selectedProviders={selectedProviders}
                  onToggle={toggleProvider}
                  onSelectArchive={() => {
                    void handleSelectArchive();
                  }}
                />
              </>
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
                    dispatchScanState({ type: "source-changed" });
                    setArchivePath(null);
                    setDays(externalImportDefaultDays);
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
                <>
                  {archiveMode && importing ? (
                    <span aria-live="polite" className="sr-only" role="status">
                      {t("workspace.externalImport.importing")}
                    </span>
                  ) : null}
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
                </>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportSelectStep({
  archiveMode,
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
  showProjectRegistration,
  showRange,
  totalCount
}: {
  archiveMode: boolean;
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
  showProjectRegistration: boolean;
  showRange: boolean;
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
  const searchPlaceholder = t(
    archiveMode
      ? "workspace.externalImport.archiveSearchPlaceholder"
      : "workspace.externalImport.searchPlaceholder"
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {archiveMode ? (
        <p aria-live="polite" className="sr-only" role="status">
          {t("workspace.externalImport.archiveSelectionReady", {
            count: totalCount
          })}
        </p>
      ) : null}
      <div className="flex shrink-0 flex-col gap-3 px-5 pb-3 pt-4">
        {showRange ? (
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
        ) : null}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-placeholder)]" />
          <input
            aria-label={searchPlaceholder}
            type="text"
            value={search}
            disabled={disabled}
            placeholder={searchPlaceholder}
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
          <CenteredExternalAgentSessionImportState
            icon={<FolderIcon className="size-5" />}
            text={
              totalCount === 0
                ? t(
                    archiveMode
                      ? "workspace.externalImport.archiveEmpty"
                      : "workspace.externalImport.empty"
                  )
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
      {showProjectRegistration ? (
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
      ) : null}
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
