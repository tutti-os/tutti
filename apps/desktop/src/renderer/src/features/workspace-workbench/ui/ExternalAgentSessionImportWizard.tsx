import { useEffect, useMemo, useState } from "react";
import type * as React from "react";
import type {
  ExternalAgentImportProject,
  ExternalAgentImportResultResponse,
  ExternalAgentImportScanResponse,
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FolderIcon,
  LoadingIcon,
  RefreshIcon,
  UploadIcon
} from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";
import { useTranslation } from "@renderer/i18n";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";

const externalImportProviderOptions: WorkspaceAgentProvider[] = [
  "codex",
  "claude-code"
];

type ExternalImportStep = "providers" | "options";
type ExternalImportOption = "projects" | "chats";

const externalImportListCheckboxClass =
  "focus-visible:!ring-0 focus-visible:border-[var(--border-1)] data-[state=checked]:focus-visible:border-[var(--text-primary)]";

const externalImportListItemClass =
  "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[8px] bg-[var(--transparency-block)] p-3 transition-colors hover:bg-[var(--transparency-hover)]";

const externalImportOptionDefaults: ExternalImportOption[] = [
  "projects",
  "chats"
];

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
  const [selectedImportOptions, setSelectedImportOptions] = useState<
    Set<ExternalImportOption>
  >(new Set(externalImportOptionDefaults));
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
    setSelectedImportOptions(new Set(externalImportOptionDefaults));
    setStep("providers");
    setScan(null);
    setError(null);
    setResult(null);
    setLoading(false);
    setImporting(false);
    return undefined;
  }, [initialProviders, open, providerKey]);

  const selectedProviderList = externalImportProviderOptions.filter(
    (provider) => selectedProviders.has(provider)
  );
  const importProjects = useMemo(
    () => externalImportProjectsFromScan(scan),
    [scan]
  );
  const canScan = selectedProviderList.length > 0 && !loading && !importing;
  const canImport =
    importProjects.length > 0 &&
    selectedImportOptions.size > 0 &&
    !loading &&
    !importing;

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

  const toggleImportOption = (
    option: ExternalImportOption,
    checked: boolean
  ) => {
    setSelectedImportOptions((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(option);
      } else {
        next.delete(option);
      }
      return next;
    });
  };

  const handleScan = async () => {
    if (!canScan) {
      return;
    }
    setLoading(true);
    setError(null);
    setScan(null);
    try {
      const nextScan =
        await workspaceAgentActivityService.scanExternalSessionImports(
          workspace.id,
          { providers: selectedProviderList }
        );
      setScan(nextScan);
      setSelectedImportOptions(new Set(externalImportOptionDefaults));
      setStep("options");
    } catch {
      setError(t("workspace.externalImport.scanFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!canImport) {
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const nextResult =
        await workspaceAgentActivityService.importExternalSessions(
          workspace.id,
          {
            projects: importProjects,
            registerUserProjects: selectedImportOptions.has("projects"),
            importSessions: selectedImportOptions.has("chats")
          }
        );
      setResult(nextResult);
    } catch {
      setError(t("workspace.externalImport.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(640px,calc(100vh-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>{t("workspace.externalImport.title")}</DialogTitle>
          <DialogDescription>
            {t("workspace.externalImport.description")}
          </DialogDescription>
        </DialogHeader>
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
          ) : step === "providers" ? (
            <ProviderSelectionList
              providers={externalImportProviderOptions}
              selectedProviders={selectedProviders}
              onToggle={toggleProvider}
            />
          ) : importProjects.length === 0 ? (
            <CenteredImportState
              icon={<FolderIcon className="size-5" />}
              text={t("workspace.externalImport.empty")}
            />
          ) : (
            <ImportOptionSelectionList
              scan={scan}
              selectedOptions={selectedImportOptions}
              onToggle={toggleImportOption}
            />
          )}
        </div>
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
                  if (step === "options") {
                    setStep("providers");
                    setError(null);
                    return;
                  }
                  onOpenChange(false);
                }}
              >
                {step === "options"
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

function ImportOptionSelectionList({
  onToggle,
  scan,
  selectedOptions
}: {
  onToggle: (option: ExternalImportOption, checked: boolean) => void;
  scan: ExternalAgentImportScanResponse | null;
  selectedOptions: Set<ExternalImportOption>;
}) {
  const { t } = useTranslation();
  if (!scan) {
    return null;
  }
  const options: {
    description: string;
    id: ExternalImportOption;
    title: string;
  }[] = [
    {
      description: t("workspace.externalImport.projectOptionDescription"),
      id: "projects",
      title: t("workspace.externalImport.projectOptionTitle", {
        count: scan.projects.length
      })
    },
    {
      description: t("workspace.externalImport.chatOptionDescription", {
        messages: scan.scannedMessages
      }),
      id: "chats",
      title: t("workspace.externalImport.chatOptionTitle", {
        count: scan.scannedSessions
      })
    }
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] leading-[1.4] text-[var(--text-secondary)]">
        {t("workspace.externalImport.optionDescription")}
      </p>
      <div className="flex flex-col gap-2">
        {options.map((option) => {
          const checked = selectedOptions.has(option.id);
          return (
            <label key={option.id} className={externalImportListItemClass}>
              <Checkbox
                aria-label={t("workspace.externalImport.selectImportOption", {
                  label: option.title
                })}
                checked={checked}
                className={externalImportListCheckboxClass}
                onCheckedChange={(value) => onToggle(option.id, value === true)}
              />
              <span className="min-w-0">
                <strong className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                  {option.title}
                </strong>
                <span className="mt-1 block text-[12px] text-[var(--text-secondary)]">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function externalImportProjectsFromScan(
  scan: ExternalAgentImportScanResponse | null
) {
  return (scan?.projects ?? []).map((project: ExternalAgentImportProject) => ({
    path: project.path,
    providers: project.providers
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
        icon={<UploadIcon className="size-5" />}
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
