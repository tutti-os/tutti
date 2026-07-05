import type { FormEvent, ReactElement } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  Badge,
  BareIconButton,
  Button,
  CloseIcon,
  ConfirmationDialog,
  DeleteIcon,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FileCreateIcon,
  ImportLinedIcon as ImportIcon,
  Input,
  OpenSessionsIcon as OpenSessionsFilledIcon,
  RefreshIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SectionTabs,
  Spinner,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  UploadFolderIcon,
  cn
} from "@tutti-os/ui-system";
import type {
  AppCenterViewModel,
  WorkspaceAppFactoryJobViewModel
} from "../contracts/viewModel.ts";
import type { WorkspaceAppLocalRepairRequest } from "../contracts/host.ts";
import {
  isCommunityRecommendedApp,
  sortCommunityApps,
  sortMyAppsByCreatedDesc,
  sortRecommendedApps,
  sortRecommendedAppsForAllTab
} from "../core/appCenterAppOrdering.ts";
import {
  resolveDefaultAppFactoryProvider,
  resolveSelectedAppFactoryProvider
} from "../core/appFactoryProviderDefaults.ts";
import type { AppCenterI18nRuntime } from "../i18n/appCenterI18n.ts";
import {
  AppCard,
  type AppCenterFactoryProviderConfiguration,
  type AppCenterFactoryProviderOption,
  type AppCenterFactoryPermissionOption,
  type AppCenterHostActions
} from "./AppCard.tsx";

type FactoryTemplateID =
  | "lovart"
  | "weather"
  | "lookup"
  | "system"
  | "news"
  | "gomoku";
export type AppCenterAppTab = "recommended" | "community" | "my";
type RecommendedCategoryTabID =
  | "all"
  | "product-design"
  | "office"
  | "tools"
  | "content-creation";
type FactorySettingsMenu = "model" | "permission" | "provider" | "reasoning";

interface FactoryTemplate {
  readonly id: FactoryTemplateID;
  readonly defaultNameKey: string;
  readonly promptKey: string;
  readonly titleKey: string;
}

const factoryTemplates: readonly FactoryTemplate[] = [
  {
    defaultNameKey: "factory.templates.lovart.defaultName",
    id: "lovart",
    promptKey: "factory.templates.lovart.prompt",
    titleKey: "factory.templates.lovart.title"
  },
  {
    defaultNameKey: "factory.templates.weather.defaultName",
    id: "weather",
    promptKey: "factory.templates.weather.prompt",
    titleKey: "factory.templates.weather.title"
  },
  {
    defaultNameKey: "factory.templates.lookup.defaultName",
    id: "lookup",
    promptKey: "factory.templates.lookup.prompt",
    titleKey: "factory.templates.lookup.title"
  },
  {
    defaultNameKey: "factory.templates.system.defaultName",
    id: "system",
    promptKey: "factory.templates.system.prompt",
    titleKey: "factory.templates.system.title"
  },
  {
    defaultNameKey: "factory.templates.news.defaultName",
    id: "news",
    promptKey: "factory.templates.news.prompt",
    titleKey: "factory.templates.news.title"
  },
  {
    defaultNameKey: "factory.templates.gomoku.defaultName",
    id: "gomoku",
    promptKey: "factory.templates.gomoku.prompt",
    titleKey: "factory.templates.gomoku.title"
  }
];

const recommendedCategoryTabDefinitions: readonly (
  | {
      readonly id: "all";
      readonly labelKey: null;
    }
  | {
      readonly id: Exclude<RecommendedCategoryTabID, "all">;
      readonly labelKey: string;
    }
)[] = [
  { id: "all", labelKey: null },
  { id: "product-design", labelKey: "categories.productDesign" },
  { id: "content-creation", labelKey: "categories.contentCreation" },
  { id: "office", labelKey: "categories.office" },
  { id: "tools", labelKey: "categories.tools" }
];

export interface AppCenterPanelProps {
  readonly actions: AppCenterHostActions;
  readonly activeAppTab?: AppCenterAppTab;
  readonly catalogStatus?: "failed" | "loading";
  readonly className?: string;
  readonly copy: AppCenterI18nRuntime;
  readonly defaultAgentTargetId?: string | null;
  readonly errorMessage?: string;
  readonly loadProviderConfiguration?: (
    agentTargetId: string
  ) => Promise<AppCenterFactoryProviderConfiguration>;
  readonly onActiveAppTabChange?: (tab: AppCenterAppTab) => void;
  readonly officialDeveloperIconUrl?: string | null;
  readonly providerErrorMessage?: string | null;
  readonly providerLoading?: boolean;
  readonly providerOptions?: readonly AppCenterFactoryProviderOption[];
  readonly showDeveloperSources?: boolean;
  readonly viewModel: AppCenterViewModel;
}

export function AppCenterPanel({
  actions,
  activeAppTab: controlledActiveAppTab,
  catalogStatus,
  className,
  copy,
  defaultAgentTargetId = null,
  errorMessage,
  loadProviderConfiguration,
  onActiveAppTabChange,
  officialDeveloperIconUrl = null,
  providerErrorMessage = null,
  providerLoading = false,
  providerOptions = [],
  showDeveloperSources = false,
  viewModel
}: AppCenterPanelProps): ReactElement {
  const promptTextareaId = useId();
  const [factoryDialogOpen, setFactoryDialogOpen] = useState(false);
  const [deleteAppBusy, setDeleteAppBusy] = useState(false);
  const [pendingDeleteApp, setPendingDeleteApp] = useState<{
    id: string;
    installed: boolean;
    name: string;
  } | null>(null);
  const [uninstallAppBusy, setUninstallAppBusy] = useState(false);
  const [pendingUninstallApp, setPendingUninstallApp] = useState<{
    id: string;
    name: string;
    sourceKind: AppCenterViewModel["apps"][number]["sourceKind"];
  } | null>(null);
  const [pendingLocalRepairRequest, setPendingLocalRepairRequest] =
    useState<WorkspaceAppLocalRepairRequest | null>(null);
  const [updateAppBusy, setUpdateAppBusy] = useState(false);
  const [localRepairBusy, setLocalRepairBusy] = useState(false);
  const [pendingUpdateApp, setPendingUpdateApp] = useState<{
    id: string;
    name: string;
    trigger: "badge_button" | "primary_action";
  } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [providerConfiguration, setProviderConfiguration] =
    useState<AppCenterFactoryProviderConfiguration | null>(null);
  const [providerConfigurationStatus, setProviderConfigurationStatus] =
    useState<"idle" | "loading" | "ready">("idle");
  const [openFactorySettingsMenu, setOpenFactorySettingsMenu] =
    useState<FactorySettingsMenu | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedPermissionModeId, setSelectedPermissionModeId] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const normalizedProviderOptions = useMemo(
    () =>
      providerOptions
        .map((option) => {
          const provider = option.provider.trim();
          const agentTargetId = option.agentTargetId.trim();
          const label = option.label.trim() || provider;
          if (!agentTargetId || !provider || !label) {
            return null;
          }
          return {
            ...option,
            ...(option.disabledReason?.trim()
              ? { disabledReason: option.disabledReason.trim() }
              : {}),
            ...(option.iconUrl?.trim()
              ? { iconUrl: option.iconUrl.trim() }
              : {}),
            label,
            agentTargetId,
            provider
          };
        })
        .filter((option) => option != null),
    [providerOptions]
  );
  const [selectedProvider, setSelectedProvider] = useState(() =>
    resolveDefaultAppFactoryProvider(
      normalizedProviderOptions,
      defaultAgentTargetId
    )
  );
  const [uncontrolledActiveAppTab, setUncontrolledActiveAppTab] =
    useState<AppCenterAppTab>("recommended");
  const [activeRecommendedCategoryTab, setActiveRecommendedCategoryTab] =
    useState<RecommendedCategoryTabID>("all");
  const activeAppTab = controlledActiveAppTab ?? uncontrolledActiveAppTab;
  useEffect(() => {
    setSelectedProvider((current) =>
      resolveSelectedAppFactoryProvider(
        current,
        normalizedProviderOptions,
        defaultAgentTargetId
      )
    );
  }, [defaultAgentTargetId, normalizedProviderOptions]);
  const selectedProviderOption =
    normalizedProviderOptions.find(
      (option) => option.agentTargetId === selectedProvider
    ) ?? null;
  useEffect(() => {
    if (!factoryDialogOpen) {
      setProviderConfiguration(null);
      setProviderConfigurationStatus("idle");
      return;
    }
    const agentTargetId = selectedProviderOption?.agentTargetId?.trim() ?? "";
    if (!agentTargetId || !loadProviderConfiguration) {
      setProviderConfiguration(null);
      setProviderConfigurationStatus("ready");
      return;
    }
    let canceled = false;
    setProviderConfiguration(null);
    setProviderConfigurationStatus("loading");
    void loadProviderConfiguration(agentTargetId)
      .then((configuration) => {
        if (canceled) {
          return;
        }
        setProviderConfiguration(configuration);
        setProviderConfigurationStatus("ready");
      })
      .catch(() => {
        if (canceled) {
          return;
        }
        setProviderConfiguration(null);
        setProviderConfigurationStatus("ready");
      });
    return () => {
      canceled = true;
    };
  }, [
    factoryDialogOpen,
    loadProviderConfiguration,
    selectedProvider,
    selectedProviderOption?.agentTargetId
  ]);
  const modelOptions = providerConfiguration?.modelOptions ?? [];
  const permissionModeOptions =
    providerConfiguration?.permissionModeOptions ?? [];
  const reasoningEffortOptions =
    providerConfiguration?.reasoningEffortOptions ?? [];
  useEffect(() => {
    setSelectedModel((current) =>
      resolveSelectedFactoryOptionValue(
        current,
        modelOptions,
        providerConfiguration?.defaultModel
      )
    );
  }, [modelOptions, providerConfiguration?.defaultModel]);
  useEffect(() => {
    setSelectedPermissionModeId((current) =>
      resolveSelectedFactoryOptionValue(
        current,
        permissionModeOptions,
        providerConfiguration?.defaultPermissionModeId
      )
    );
  }, [permissionModeOptions, providerConfiguration?.defaultPermissionModeId]);
  useEffect(() => {
    setSelectedReasoningEffort((current) =>
      resolveSelectedFactoryOptionValue(
        current,
        reasoningEffortOptions,
        providerConfiguration?.defaultReasoningEffort
      )
    );
  }, [providerConfiguration?.defaultReasoningEffort, reasoningEffortOptions]);
  const setActiveAppTab = (tab: AppCenterAppTab): void => {
    if (controlledActiveAppTab === undefined) {
      setUncontrolledActiveAppTab(tab);
    }
    onActiveAppTabChange?.(tab);
  };
  const factoryJobs = viewModel.factoryJobs ?? [];
  const hasFactoryJobs = factoryJobs.length > 0;
  const closeFactoryDialog = (): void => {
    setFactoryDialogOpen(false);
    setDisplayName("");
    setPrompt("");
    setProviderConfiguration(null);
    setProviderConfigurationStatus("idle");
    setOpenFactorySettingsMenu(null);
    setSelectedModel("");
    setSelectedPermissionModeId("");
    setSelectedReasoningEffort("");
  };
  const openFactoryDialog = (): void => {
    setSelectedProvider(
      resolveDefaultAppFactoryProvider(
        normalizedProviderOptions,
        defaultAgentTargetId
      )
    );
    setSelectedModel("");
    setSelectedPermissionModeId("");
    setSelectedReasoningEffort("");
    setProviderConfiguration(null);
    setProviderConfigurationStatus("idle");
    setOpenFactorySettingsMenu(null);
    setFactoryDialogOpen(true);
  };
  const canCreateFactoryJob =
    !!displayName.trim() &&
    !!prompt.trim() &&
    providerConfigurationStatus !== "loading" &&
    !!selectedProviderOption &&
    selectedProviderOption.disabled !== true;
  const submitCreate = (event: FormEvent): void => {
    event.preventDefault();
    const normalizedDisplayName = displayName.trim();
    const normalizedPrompt = prompt.trim();
    if (
      !normalizedDisplayName ||
      !normalizedPrompt ||
      !selectedProviderOption ||
      selectedProviderOption.disabled === true
    ) {
      return;
    }
    setDisplayName("");
    setPrompt("");
    setFactoryDialogOpen(false);
    void actions.createFactoryJob?.({
      displayName: normalizedDisplayName,
      ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
      ...(selectedPermissionModeId.trim()
        ? { permissionModeId: selectedPermissionModeId.trim() }
        : {}),
      agentTargetId: selectedProviderOption.agentTargetId,
      prompt: normalizedPrompt,
      ...(selectedReasoningEffort.trim()
        ? { reasoningEffort: selectedReasoningEffort.trim() }
        : {})
    });
  };
  const selectTemplate = (template: FactoryTemplate): void => {
    setDisplayName(copy.t(template.defaultNameKey));
    setPrompt(copy.t(template.promptKey));
  };
  const openFactoryJobAgentSession = (job: {
    agentTargetId?: string | null;
    agentSessionId?: string | null;
    provider?: string | null;
  }): void => {
    const agentSessionId = job.agentSessionId?.trim();
    if (!agentSessionId) {
      return;
    }
    void actions.openFactoryJobAgentSession?.(
      agentSessionId,
      job.provider,
      job.agentTargetId
    );
  };
  const loadLocalApp = (): void => {
    void Promise.resolve(actions.loadLocalApp?.()).then((request) => {
      if (request) {
        setPendingLocalRepairRequest(request);
      }
    });
  };
  const cardActions = useMemo<AppCenterHostActions>(
    () => ({
      ...actions,
      deleteApp: (appId, appName) => {
        setPendingDeleteApp({
          id: appId,
          installed:
            viewModel.apps.find((app) => app.id === appId)?.installed ?? false,
          name: appName
        });
      },
      uninstallApp: (appId) => {
        const app = viewModel.apps.find((item) => item.id === appId);
        if (!app) {
          return;
        }
        setPendingUninstallApp({
          id: app.id,
          name: app.name,
          sourceKind: app.sourceKind
        });
      },
      updateApp: (appId, trigger) => {
        const app = viewModel.apps.find((item) => item.id === appId);
        if (!app) {
          return;
        }
        const shouldConfirmUpdate =
          app.installed &&
          app.status === "running" &&
          (actions.shouldConfirmAppUpdate?.(app.id) ?? true);
        if (shouldConfirmUpdate) {
          setPendingUpdateApp({
            id: app.id,
            name: app.name,
            trigger
          });
          return;
        }
        void actions.updateApp?.(appId, trigger);
      }
    }),
    [actions, viewModel.apps]
  );
  const loadingMessage =
    catalogStatus === "loading" ? copy.t("messages.catalogLoading") : null;
  const catalogLoading = catalogStatus === "loading";
  const failedMessage =
    catalogStatus === "failed" ? copy.t("messages.catalogFailed") : null;
  const statusToast =
    errorMessage != null
      ? {
          busy: false,
          message: errorMessage,
          tone: "destructive" as const
        }
      : failedMessage != null
        ? {
            busy: false,
            message: failedMessage,
            tone: "destructive" as const
          }
        : loadingMessage != null
          ? {
              busy: true,
              message: loadingMessage,
              tone: "default" as const
            }
          : null;
  const myApps = sortMyAppsByCreatedDesc(
    viewModel.apps.filter((app) => app.sourceKind === "local")
  );
  const recommendedSourceApps = viewModel.apps.filter(
    (app) => app.sourceKind !== "local" && !isCommunityRecommendedApp(app.id)
  );
  const communitySourceApps = viewModel.apps.filter(
    (app) => app.sourceKind !== "local" && isCommunityRecommendedApp(app.id)
  );
  const recommendedApps = sortRecommendedApps(recommendedSourceApps);
  const recommendedAppsForAllTab = sortRecommendedAppsForAllTab(
    recommendedSourceApps
  );
  const communityApps = sortCommunityApps(communitySourceApps);
  const recommendedCategoryTabs = createRecommendedCategoryTabs(
    recommendedApps,
    copy
  );
  const activeRecommendedCategoryLabel =
    recommendedCategoryTabs.find(
      (tab) => tab.id === activeRecommendedCategoryTab
    )?.category ?? null;
  const activeRecommendedApps =
    activeRecommendedCategoryLabel == null
      ? recommendedAppsForAllTab
      : recommendedApps.filter(
          (app) => app.category === activeRecommendedCategoryLabel
        );
  const activeApps =
    activeAppTab === "recommended"
      ? activeRecommendedApps
      : activeAppTab === "community"
        ? communityApps
        : myApps;
  const activeAppTabTitle =
    activeAppTab === "recommended"
      ? copy.t("labels.recommendedApps")
      : activeAppTab === "community"
        ? copy.t("labels.communityApps")
        : copy.t("labels.myApps");
  const activeAppEmptyMessage =
    activeAppTab === "recommended"
      ? copy.t("messages.recommendedAppsEmpty")
      : activeAppTab === "community"
        ? copy.t("messages.communityAppsEmpty")
        : copy.t("messages.myAppsEmpty");
  const pendingDeleteAppInstalled = pendingDeleteApp?.installed ?? false;
  const deleteAppConfirmLabel = copy.t(
    pendingDeleteAppInstalled
      ? "actions.uninstallAndDeleteApp"
      : "actions.deleteApp"
  );
  const deleteAppConfirmDescription = copy.t(
    pendingDeleteAppInstalled
      ? "confirmations.uninstallAndDeleteAppDescription"
      : "confirmations.deleteAppDescription"
  );
  const deleteAppConfirmTitle = copy.t(
    pendingDeleteAppInstalled
      ? "confirmations.uninstallAndDeleteAppTitle"
      : "confirmations.deleteAppTitle",
    {
      name: pendingDeleteApp?.name ?? ""
    }
  );
  const pendingUninstallAppLocal = pendingUninstallApp?.sourceKind === "local";
  const uninstallAppConfirmDescription = copy.t(
    pendingUninstallAppLocal
      ? "confirmations.uninstallAppDescriptionLocal"
      : "confirmations.uninstallAppDescriptionRecommended"
  );
  const uninstallAppConfirmTitle = copy.t("confirmations.uninstallAppTitle", {
    name: pendingUninstallApp?.name ?? ""
  });
  const updateAppConfirmTitle = copy.t("confirmations.updateAppTitle", {
    name: pendingUpdateApp?.name ?? ""
  });
  const localRepairDialogTitle = copy.t("localDev.repairDialog.title");
  const localRepairDialogDescription = copy.t(
    "localDev.repairDialog.description"
  );

  return (
    <section
      aria-label={copy.t("title")}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[var(--background-panel)] text-[var(--text-primary)]",
        className
      )}
    >
      {statusToast ? <AppCenterStatusToast toast={statusToast} /> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-6 pt-5 [container-type:inline-size]">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex h-8 min-w-0 items-center justify-between gap-3">
            <SectionTabs
              ariaLabel={copy.t("labels.appList")}
              className="h-8"
              tabs={[
                {
                  label: copy.t("labels.recommendedApps"),
                  value: "recommended"
                },
                {
                  label: copy.t("labels.communityApps"),
                  value: "community"
                },
                {
                  label: copy.t("labels.myApps"),
                  value: "my"
                }
              ]}
              value={activeAppTab}
              onValueChange={setActiveAppTab}
            />
            <div className="flex h-8 shrink-0 items-center gap-1">
              {activeAppTab === "my" ? (
                <AppCenterHeaderActions
                  copy={copy}
                  onCreateApp={() => {
                    openFactoryDialog();
                  }}
                  onImportApp={() => {
                    void actions.importApp?.();
                  }}
                  onLoadLocalApp={loadLocalApp}
                />
              ) : (
                <AppCenterRecommendedHeaderActions
                  copy={copy}
                  loading={catalogLoading}
                  onRefreshCatalog={() => {
                    void actions.refreshCatalog?.();
                  }}
                />
              )}
            </div>
          </div>
          {activeAppTab === "my" && hasFactoryJobs ? (
            <section className="min-w-0">
              <h2 className="mb-3 text-[15px] font-semibold leading-5 tracking-[0] text-[var(--text-primary)]">
                {copy.t("factory.labels.jobs")}
              </h2>
              <div className="flex min-w-0 flex-col gap-2">
                {factoryJobs.map((job) => (
                  <article
                    aria-disabled={job.canOpenAgentSession ? undefined : true}
                    className={cn(
                      "group flex min-w-0 items-center justify-between gap-3 rounded-[8px] border border-[color:var(--line-2)] bg-[var(--background-fronted)] p-[12px] text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]",
                      job.canOpenAgentSession
                        ? "cursor-pointer hover:bg-[var(--transparency-block)]"
                        : "cursor-default"
                    )}
                    key={job.id}
                    role="button"
                    tabIndex={job.canOpenAgentSession ? 0 : -1}
                    onClick={() => openFactoryJobAgentSession(job)}
                    onKeyDown={(event) => {
                      if (
                        !job.canOpenAgentSession ||
                        event.currentTarget !== event.target ||
                        (event.key !== "Enter" && event.key !== " ")
                      ) {
                        return;
                      }
                      event.preventDefault();
                      openFactoryJobAgentSession(job);
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                          {job.title}
                        </h3>
                        <FactoryJobStatusIndicator copy={copy} job={job} />
                      </div>
                      {job.failureReason ? (
                        <p
                          className="mt-2 truncate text-[11px] leading-4 text-[var(--state-danger)]"
                          title={job.failureReason}
                        >
                          {copy.t(
                            job.canFix
                              ? "factory.messages.factoryJobFailedWithFix"
                              : "factory.messages.factoryJobFailed"
                          )}
                        </p>
                      ) : (
                        <p className="mt-2 truncate text-[11px] leading-4 text-[var(--text-secondary)]">
                          {job.prompt}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {job.canRetryValidation ? (
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void actions.retryFactoryValidation?.(job.id);
                          }}
                        >
                          {copy.t("factory.actions.validate")}
                        </Button>
                      ) : null}
                      {job.canPublish ? (
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void actions.publishFactoryJob?.(job.id);
                          }}
                        >
                          {copy.t("factory.actions.publish")}
                        </Button>
                      ) : null}
                      {job.canFix ? (
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void actions.fixFactoryJob?.(
                              job.id,
                              copy.t("factory.prompts.fixDefault")
                            );
                          }}
                        >
                          {copy.t("factory.actions.fix")}
                        </Button>
                      ) : null}
                      {job.canCancel ? (
                        <Button
                          aria-label={copy.t("factory.actions.cancel")}
                          className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                          size="icon-sm"
                          title={copy.t("factory.actions.cancel")}
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void actions.cancelFactoryJob?.(job.id);
                          }}
                        >
                          <CloseIcon />
                        </Button>
                      ) : null}
                      {job.canDelete ? (
                        <BareIconButton
                          aria-label={copy.t("factory.actions.delete")}
                          className="text-[var(--text-secondary)]"
                          size="md"
                          title={copy.t("factory.actions.delete")}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void actions.deleteFactoryJob?.(job.id);
                          }}
                        >
                          <DeleteIcon />
                        </BareIconButton>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {viewModel.empty ? (
            <p className="text-[13px] leading-5 text-[var(--text-secondary)]">
              {copy.t("messages.empty")}
            </p>
          ) : null}
          {activeAppTab === "recommended" ? (
            <RecommendedCategoryTabs
              copy={copy}
              tabs={recommendedCategoryTabs}
              value={activeRecommendedCategoryTab}
              onValueChange={setActiveRecommendedCategoryTab}
            />
          ) : null}
          <AppCardGrid
            actions={cardActions}
            apps={activeApps}
            copy={copy}
            emptyMessage={activeAppEmptyMessage}
            officialDeveloperIconUrl={officialDeveloperIconUrl}
            showDeveloperSources={showDeveloperSources}
            title={activeAppTabTitle}
          />
        </section>
      </div>
      <ConfirmationDialog
        cancelLabel={copy.t("actions.cancel")}
        confirmBusy={deleteAppBusy}
        confirmLabel={deleteAppConfirmLabel}
        description={deleteAppConfirmDescription}
        open={pendingDeleteApp != null}
        title={deleteAppConfirmTitle}
        tone="destructive"
        onConfirm={() => {
          const app = pendingDeleteApp;
          if (!app) {
            return;
          }
          setDeleteAppBusy(true);
          void Promise.resolve(actions.deleteApp?.(app.id, app.name)).finally(
            () => {
              setDeleteAppBusy(false);
              setPendingDeleteApp(null);
            }
          );
        }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleteAppBusy) {
            setPendingDeleteApp(null);
          }
        }}
      />
      <ConfirmationDialog
        cancelLabel={copy.t("actions.cancel")}
        confirmBusy={uninstallAppBusy}
        confirmLabel={copy.t("actions.uninstallApp")}
        description={uninstallAppConfirmDescription}
        open={pendingUninstallApp != null}
        title={uninstallAppConfirmTitle}
        tone="destructive"
        onConfirm={() => {
          const app = pendingUninstallApp;
          if (!app) {
            return;
          }
          setUninstallAppBusy(true);
          void Promise.resolve(actions.uninstallApp?.(app.id)).finally(() => {
            setUninstallAppBusy(false);
            setPendingUninstallApp(null);
          });
        }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !uninstallAppBusy) {
            setPendingUninstallApp(null);
          }
        }}
      />
      <ConfirmationDialog
        cancelLabel={copy.t("actions.cancel")}
        confirmBusy={updateAppBusy}
        confirmLabel={copy.t("actions.updateApp")}
        description={copy.t("confirmations.updateRunningAppDescription")}
        open={pendingUpdateApp != null}
        title={updateAppConfirmTitle}
        onConfirm={() => {
          const app = pendingUpdateApp;
          if (!app) {
            return;
          }
          setUpdateAppBusy(true);
          void Promise.resolve(
            actions.updateApp?.(app.id, app.trigger)
          ).finally(() => {
            setUpdateAppBusy(false);
            setPendingUpdateApp(null);
          });
        }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !updateAppBusy) {
            setPendingUpdateApp(null);
          }
        }}
      />
      <ConfirmationDialog
        cancelLabel={copy.t("actions.cancel")}
        confirmBusy={localRepairBusy}
        confirmLabel={copy.t("localDev.repairDialog.confirm")}
        description={localRepairDialogDescription}
        open={pendingLocalRepairRequest != null}
        title={localRepairDialogTitle}
        onConfirm={() => {
          const request = pendingLocalRepairRequest;
          if (!request) {
            return;
          }
          setLocalRepairBusy(true);
          void Promise.resolve(
            actions.repairLocalApp?.({
              ...request,
              prompt: copy.t("localDev.repairPrompt", {
                cwd: request.projectDir
              })
            })
          ).finally(() => {
            setLocalRepairBusy(false);
            setPendingLocalRepairRequest(null);
          });
        }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !localRepairBusy) {
            setPendingLocalRepairRequest(null);
          }
        }}
      />
      <Dialog
        open={factoryDialogOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeFactoryDialog();
            return;
          }
          openFactoryDialog();
        }}
      >
        <DialogContent
          className="sm:max-w-[min(640px,calc(100%-2rem))]"
          showCloseButton={false}
        >
          <form
            className="grid max-h-[min(760px,calc(100vh-64px))] min-w-0 gap-4 overflow-auto"
            onSubmit={submitCreate}
          >
            <DialogHeader>
              <DialogTitle>{copy.t("factory.labels.create")}</DialogTitle>
            </DialogHeader>
            <label className="grid min-w-0 gap-2">
              <span className="text-[11px] font-semibold leading-4 text-[var(--text-secondary)]">
                {copy.t("factory.labels.appName")}
              </span>
              <Input
                autoFocus
                className="h-9 rounded-[8px]"
                placeholder={copy.t("factory.placeholders.appName")}
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
            </label>
            <div className="grid min-w-0 gap-4">
              <div className="grid min-w-0 gap-2">
                <label
                  className="text-[11px] font-semibold leading-4 text-[var(--text-secondary)]"
                  htmlFor={promptTextareaId}
                >
                  {copy.t("factory.labels.prompt")}
                </label>
                <div className="relative min-w-0">
                  <Textarea
                    className="min-h-[148px] resize-none rounded-[10px] pb-14 leading-[1.45] sm:pb-8"
                    id={promptTextareaId}
                    placeholder={copy.t("factory.placeholders.prompt")}
                    value={prompt}
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                  />
                  <div className="pointer-events-none absolute inset-x-3 bottom-1.5 flex min-w-0 flex-wrap items-end justify-between gap-2">
                    {providerErrorMessage &&
                    normalizedProviderOptions.length === 0 ? (
                      <p className="pointer-events-auto max-w-[240px] text-[11px] leading-4 text-[var(--state-danger)]">
                        {providerErrorMessage}
                      </p>
                    ) : (
                      <span aria-hidden="true" className="min-h-4 flex-1" />
                    )}
                    <div className="pointer-events-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-0.5 px-0.5 py-0">
                      <FactoryProviderSelect
                        copy={copy}
                        errorMessage={providerErrorMessage}
                        loading={providerLoading}
                        open={openFactorySettingsMenu === "provider"}
                        options={normalizedProviderOptions}
                        selectedProvider={selectedProvider}
                        triggerClassName="h-6 w-auto max-w-full border-0 bg-transparent px-1.5 text-[11px] font-medium text-[var(--text-secondary)] shadow-none hover:bg-transparent focus-visible:bg-transparent data-[placeholder]:text-[var(--text-tertiary)]"
                        onOpenChange={(nextOpen) =>
                          setOpenFactorySettingsMenu(
                            nextOpen ? "provider" : null
                          )
                        }
                        onSelectProvider={setSelectedProvider}
                      />
                      <div
                        aria-hidden="true"
                        className="h-4 w-px bg-[var(--line-2)]"
                      />
                      <FactoryPermissionDropdown
                        copy={copy}
                        loading={providerConfigurationStatus === "loading"}
                        open={openFactorySettingsMenu === "permission"}
                        options={permissionModeOptions}
                        selectedPermissionModeId={selectedPermissionModeId}
                        triggerClassName="h-6 w-auto max-w-full border-0 bg-transparent px-1.5 text-[11px] font-medium text-[var(--text-secondary)] shadow-none hover:bg-transparent focus-visible:bg-transparent"
                        onOpenChange={(nextOpen) =>
                          setOpenFactorySettingsMenu(
                            nextOpen ? "permission" : null
                          )
                        }
                        onSelectPermissionMode={setSelectedPermissionModeId}
                      />
                      <div
                        aria-hidden="true"
                        className="h-4 w-px bg-[var(--line-2)]"
                      />
                      <FactoryOptionDropdown
                        ariaLabel={copy.t("factory.labels.model")}
                        emptyMessage={copy.t("factory.messages.noModelOptions")}
                        loading={providerConfigurationStatus === "loading"}
                        loadingMessage={copy.t(
                          "factory.messages.loadingConfiguration"
                        )}
                        open={openFactorySettingsMenu === "model"}
                        options={modelOptions}
                        selectedValue={selectedModel}
                        triggerClassName="h-6 w-auto max-w-full border-0 bg-transparent px-1.5 text-[11px] font-medium text-[var(--text-secondary)] shadow-none hover:bg-transparent focus-visible:bg-transparent"
                        onOpenChange={(nextOpen) =>
                          setOpenFactorySettingsMenu(nextOpen ? "model" : null)
                        }
                        onSelectValue={setSelectedModel}
                      />
                      <div
                        aria-hidden="true"
                        className="h-4 w-px bg-[var(--line-2)]"
                      />
                      <FactoryOptionDropdown
                        ariaLabel={copy.t("factory.labels.reasoningEffort")}
                        emptyMessage={copy.t(
                          "factory.messages.noReasoningEffortOptions"
                        )}
                        loading={providerConfigurationStatus === "loading"}
                        loadingMessage={copy.t(
                          "factory.messages.loadingConfiguration"
                        )}
                        open={openFactorySettingsMenu === "reasoning"}
                        options={reasoningEffortOptions}
                        selectedValue={selectedReasoningEffort}
                        triggerClassName="h-6 w-auto max-w-full border-0 bg-transparent px-1.5 text-[11px] font-medium text-[var(--text-secondary)] shadow-none hover:bg-transparent focus-visible:bg-transparent"
                        onOpenChange={(nextOpen) =>
                          setOpenFactorySettingsMenu(
                            nextOpen ? "reasoning" : null
                          )
                        }
                        onSelectValue={setSelectedReasoningEffort}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <fieldset className="min-w-0 border-0 p-0">
                <legend className="sr-only">
                  {copy.t("factory.labels.templates")}
                </legend>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="shrink-0 text-[13px] font-medium leading-5 text-[var(--text-secondary)]">
                    {copy.t("factory.labels.templateInspirationPrefix")}
                  </span>
                  {factoryTemplates.map((template) => (
                    <button
                      className="inline-flex max-w-full items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-medium leading-5 text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]"
                      key={template.id}
                      type="button"
                      onClick={() => selectTemplate(template)}
                    >
                      <span className="truncate">
                        {copy.t(template.titleKey)}
                      </span>
                      <OpenSessionsFilledIcon
                        aria-hidden="true"
                        className="shrink-0"
                        size={14}
                      />
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <DialogFooter>
              <Button
                size="dialog"
                type="button"
                variant="ghost"
                onClick={closeFactoryDialog}
              >
                {copy.t("factory.actions.cancel")}
              </Button>
              <Button
                disabled={!canCreateFactoryJob}
                size="dialog"
                type="submit"
              >
                {copy.t("factory.actions.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function FactoryProviderSelect({
  copy,
  errorMessage,
  loading,
  onOpenChange,
  onSelectProvider,
  open,
  options,
  selectedProvider,
  triggerClassName
}: {
  copy: AppCenterI18nRuntime;
  errorMessage?: string | null;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectProvider: (provider: string) => void;
  open: boolean;
  options: readonly AppCenterFactoryProviderOption[];
  selectedProvider: string;
  triggerClassName?: string;
}): ReactElement {
  const selectedOption =
    options.find((option) => option.agentTargetId === selectedProvider) ?? null;
  const placeholder =
    options.length > 0
      ? copy.t("factory.messages.noAgentProviders")
      : loading
        ? copy.t("factory.messages.loadingProviders")
        : errorMessage?.trim() || copy.t("factory.messages.noAgentProviders");

  return (
    <Select
      disabled={options.length === 0}
      open={open}
      value={selectedProvider}
      onOpenChange={onOpenChange}
      onValueChange={onSelectProvider}
    >
      <SelectTrigger
        aria-label={copy.t("factory.labels.agent")}
        className={cn(
          "h-9 w-full rounded-[8px] px-3 font-normal [&_[data-slot=select-value]]:flex [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:items-center [&_[data-slot=select-value]]:gap-2",
          loading && options.length === 0 ? "animate-pulse" : null,
          triggerClassName
        )}
      >
        <SelectValue placeholder={placeholder}>
          {selectedOption ? (
            <span className="flex min-w-0 items-center gap-2">
              <AppCenterAgentProviderIcon iconUrl={selectedOption.iconUrl} />
              <span className="truncate">{selectedOption.label}</span>
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        className="w-[300px] min-w-[240px] max-w-[min(100vw-64px,480px)]"
        style={{ zIndex: "var(--z-dialog-popover)" }}
      >
        {options.length === 0 ? (
          <SelectItem disabled value="__no-provider__">
            {copy.t("factory.messages.noAgentProviders")}
          </SelectItem>
        ) : (
          options.map((option) => (
            <SelectItem
              disabled={option.disabled === true}
              key={option.agentTargetId}
              title={option.disabledReason}
              value={option.agentTargetId}
            >
              <span className="flex min-w-0 items-center gap-2">
                <AppCenterAgentProviderIcon iconUrl={option.iconUrl} />
                <span className="truncate">{option.label}</span>
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}

function FactoryPermissionDropdown({
  copy,
  loading,
  onOpenChange,
  onSelectPermissionMode,
  open,
  options,
  selectedPermissionModeId,
  triggerClassName
}: {
  copy: AppCenterI18nRuntime;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectPermissionMode: (value: string) => void;
  open: boolean;
  options: readonly AppCenterFactoryPermissionOption[];
  selectedPermissionModeId: string;
  triggerClassName?: string;
}): ReactElement {
  const selectedOption =
    options.find((option) => option.value === selectedPermissionModeId) ?? null;
  const disabled = loading || options.length === 0;
  const selectedLabel = selectedOption
    ? permissionOptionLabel(copy, selectedOption)
    : selectedPermissionModeId;

  return (
    <Select
      disabled={disabled}
      open={open}
      value={selectedPermissionModeId}
      onOpenChange={onOpenChange}
      onValueChange={onSelectPermissionMode}
    >
      <SelectTrigger
        aria-label={copy.t("factory.labels.review")}
        className={cn(
          "h-9 max-w-full rounded-[999px] border border-[color:var(--line-2)] bg-[var(--background-panel)] px-3 text-[13px] font-medium text-[var(--text-primary)] shadow-none hover:bg-[var(--transparency-block)] [&>svg:last-child]:opacity-70",
          loading
            ? "animate-pulse rounded-none border-transparent bg-transparent px-1 opacity-100 shadow-none hover:bg-transparent disabled:bg-transparent disabled:opacity-100"
            : null,
          disabled && !loading
            ? "cursor-not-allowed text-[var(--text-tertiary)] opacity-60 hover:bg-[var(--background-panel)]"
            : null,
          triggerClassName
        )}
      >
        <span className="flex min-w-0 items-center overflow-hidden">
          {selectedLabel ? (
            <span className="min-w-0 truncate">{selectedLabel}</span>
          ) : (
            <span className="min-w-0 truncate text-[var(--text-tertiary)]">
              {loading
                ? copy.t("factory.messages.loadingConfiguration")
                : copy.t("factory.messages.noPermissionOptions")}
            </span>
          )}
        </span>
      </SelectTrigger>
      <SelectContent
        align="end"
        className="w-max min-w-[220px] max-w-[min(100vw-32px,360px)] data-[side=top]:!translate-y-0"
        sideOffset={4}
        style={{ zIndex: "var(--z-dialog-popover)" }}
      >
        {options.length > 0 ? (
          options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="min-w-0 truncate">
                {permissionOptionLabel(copy, option)}
              </span>
            </SelectItem>
          ))
        ) : (
          <SelectItem disabled value="__empty__">
            {copy.t("factory.messages.noPermissionOptions")}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function FactoryOptionDropdown({
  ariaLabel,
  emptyMessage,
  loading,
  loadingMessage,
  onOpenChange,
  onSelectValue,
  open,
  options,
  selectedValue,
  triggerClassName
}: {
  ariaLabel: string;
  emptyMessage: string;
  loading: boolean;
  loadingMessage: string;
  onOpenChange: (open: boolean) => void;
  onSelectValue: (value: string) => void;
  open: boolean;
  options: readonly { label: string; value: string }[];
  selectedValue: string;
  triggerClassName?: string;
}): ReactElement {
  const disabled = loading || options.length === 0;
  const selectedLabel =
    options.find((option) => option.value === selectedValue)?.label ??
    selectedValue;

  return (
    <Select
      disabled={disabled}
      open={open}
      value={selectedValue}
      onOpenChange={onOpenChange}
      onValueChange={onSelectValue}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(
          "h-9 max-w-full rounded-[999px] border border-[color:var(--line-2)] bg-[var(--background-panel)] px-3 text-[13px] font-medium text-[var(--text-primary)] shadow-none hover:bg-[var(--transparency-block)] [&>svg:last-child]:opacity-70",
          loading
            ? "animate-pulse rounded-none border-transparent bg-transparent px-1 opacity-100 shadow-none hover:bg-transparent disabled:bg-transparent disabled:opacity-100"
            : null,
          disabled && !loading
            ? "cursor-not-allowed text-[var(--text-tertiary)] opacity-60 hover:bg-[var(--background-panel)]"
            : null,
          triggerClassName
        )}
      >
        <span className="min-w-0 truncate">
          {selectedLabel ? (
            selectedLabel
          ) : (
            <span className="text-[var(--text-tertiary)]">
              {loading ? loadingMessage : emptyMessage}
            </span>
          )}
        </span>
      </SelectTrigger>
      <SelectContent
        align="end"
        className="w-max min-w-[200px] max-w-[min(100vw-32px,320px)] data-[side=top]:!translate-y-0"
        sideOffset={4}
        style={{ zIndex: "var(--z-dialog-popover)" }}
      >
        {options.length > 0 ? (
          options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="min-w-0 truncate">{option.label}</span>
            </SelectItem>
          ))
        ) : (
          <SelectItem disabled value="__empty__">
            {emptyMessage}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function permissionOptionLabel(
  copy: AppCenterI18nRuntime,
  option: AppCenterFactoryPermissionOption
): string {
  const semantic = option.semantic?.trim();
  if (semantic) {
    const key = `factory.permissionSemantics.${semantic}.label`;
    const translated = copy.t(key);
    if (translated !== key) {
      return translated;
    }
  }
  return option.label.trim() || option.value;
}

function AppCenterAgentProviderIcon({
  iconUrl
}: {
  iconUrl?: string | null;
}): ReactElement {
  const normalizedIconUrl = iconUrl?.trim();
  if (!normalizedIconUrl) {
    return (
      <span aria-hidden="true" className="size-4 shrink-0 rounded-[4px]" />
    );
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-[4px] object-contain"
      decoding="async"
      draggable={false}
      src={normalizedIconUrl}
    />
  );
}

function resolveSelectedFactoryOptionValue(
  currentValue: string,
  options: readonly { value: string }[],
  defaultValue?: string | null
): string {
  if (options.some((option) => option.value === currentValue)) {
    return currentValue;
  }
  const normalizedDefault = defaultValue?.trim() ?? "";
  if (
    normalizedDefault &&
    options.some((option) => option.value === normalizedDefault)
  ) {
    return normalizedDefault;
  }
  return options[0]?.value ?? "";
}

function AppCardGrid({
  actions,
  apps,
  copy,
  emptyMessage,
  officialDeveloperIconUrl,
  showDeveloperSources,
  title
}: {
  readonly actions: AppCenterHostActions;
  readonly apps: AppCenterViewModel["apps"];
  readonly copy: AppCenterI18nRuntime;
  readonly emptyMessage: string;
  readonly officialDeveloperIconUrl?: string | null;
  readonly showDeveloperSources: boolean;
  readonly title: string;
}): ReactElement {
  if (apps.length === 0) {
    return (
      <div
        aria-label={title}
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-[8px] px-6 text-center text-[13px] leading-5 text-[var(--text-secondary)]"
        role="status"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 shrink-0 flex-col">
      <div
        aria-label={title}
        className="grid min-h-0 min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3"
        role="list"
      >
        {apps.map((app) => (
          <AppCard
            actions={actions}
            app={app}
            copy={copy}
            key={app.id}
            officialDeveloperIconUrl={officialDeveloperIconUrl}
            showDeveloperSources={showDeveloperSources}
          />
        ))}
      </div>
      <div aria-hidden="true" className="h-6 shrink-0" />
    </div>
  );
}

interface RecommendedCategoryTab {
  readonly category: string | null;
  readonly count: number;
  readonly id: RecommendedCategoryTabID;
  readonly label: string;
}

function createRecommendedCategoryTabs(
  apps: AppCenterViewModel["apps"],
  copy: AppCenterI18nRuntime
): RecommendedCategoryTab[] {
  const categoryCounts = new Map<string, number>();

  for (const app of apps) {
    const category = app.category?.trim();
    if (!category) {
      continue;
    }
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  return recommendedCategoryTabDefinitions.map((definition) => {
    if (definition.id === "all") {
      return {
        category: null,
        count: apps.length,
        id: definition.id,
        label: copy.t("labels.allApps")
      };
    }

    const category = copy.t(definition.labelKey);
    return {
      category,
      count: categoryCounts.get(category) ?? 0,
      id: definition.id,
      label: category
    };
  });
}

function RecommendedCategoryTabs({
  copy,
  tabs,
  value,
  onValueChange
}: {
  readonly copy: AppCenterI18nRuntime;
  readonly tabs: readonly RecommendedCategoryTab[];
  readonly value: RecommendedCategoryTabID;
  readonly onValueChange: (value: RecommendedCategoryTabID) => void;
}): ReactElement {
  return (
    <div
      aria-label={copy.t("labels.appCategories")}
      className="-mx-1 flex min-h-10 min-w-0 items-center gap-2 overflow-x-auto px-1 py-1"
      role="tablist"
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "flex h-8 shrink-0 items-center rounded-[8px] px-3 text-[13px] font-semibold leading-5 tracking-[0] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--border-focus)]",
              selected
                ? "bg-[var(--background-fronted)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--line-1)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            )}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => onValueChange(tab.id)}
          >
            {tab.label} {tab.count}
          </button>
        );
      })}
    </div>
  );
}

function AppCenterStatusToast({
  toast
}: {
  readonly toast: {
    readonly busy: boolean;
    readonly message: string;
    readonly tone: "default" | "destructive";
  };
}): ReactElement {
  return (
    <ToastProvider>
      <ToastRoot
        key={`${toast.tone}:${toast.message}`}
        open
        anchor="node"
        busy={toast.busy}
        className={cn(
          "z-30 w-[calc(100%_-_48px)] max-w-[640px] justify-start px-4 py-3 text-left text-[11px] leading-5 shadow-[0_14px_36px_var(--shadow-elevated)]",
          toast.tone === "default"
            ? "border-[var(--line-2)] bg-[var(--background-fronted)] text-[var(--text-secondary)]"
            : ""
        )}
        nodeInsetTopPx={20}
        variant={toast.tone}
      >
        <ToastTitle className="w-full justify-start gap-2 text-left text-[11px] leading-5">
          <span className="min-w-0 truncate">{toast.message}</span>
        </ToastTitle>
      </ToastRoot>
    </ToastProvider>
  );
}

function AppCenterHeaderActions({
  copy,
  onCreateApp,
  onImportApp,
  onLoadLocalApp
}: {
  readonly copy: AppCenterI18nRuntime;
  readonly onCreateApp: () => void;
  readonly onImportApp: () => void;
  readonly onLoadLocalApp: () => void;
}): ReactElement {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="default"
            type="button"
            variant="ghost"
            onClick={onLoadLocalApp}
          >
            <UploadFolderIcon />
            <span>{copy.t("actions.loadUnpackedApp")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {copy.t("actions.loadUnpackedAppTooltip")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="default"
            type="button"
            variant="ghost"
            onClick={onImportApp}
          >
            <ImportIcon />
            <span>{copy.t("actions.importApp")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {copy.t("actions.importAppTooltip")}
        </TooltipContent>
      </Tooltip>
      <Button
        size="default"
        type="button"
        variant="ghost"
        onClick={onCreateApp}
      >
        <FileCreateIcon />
        {copy.t("factory.actions.create")}
      </Button>
    </>
  );
}

function AppCenterRecommendedHeaderActions({
  copy,
  loading,
  onRefreshCatalog
}: {
  readonly copy: AppCenterI18nRuntime;
  readonly loading: boolean;
  readonly onRefreshCatalog: () => void;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={copy.t("actions.refreshCatalog")}
          disabled={loading}
          size="icon-sm"
          title={copy.t("actions.refreshCatalog")}
          type="button"
          variant="ghost"
          onClick={onRefreshCatalog}
        >
          <RefreshIcon className={loading ? "animate-spin" : undefined} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {copy.t("actions.refreshCatalog")}
      </TooltipContent>
    </Tooltip>
  );
}

function FactoryJobStatusIndicator({
  copy,
  job
}: {
  readonly copy: AppCenterI18nRuntime;
  readonly job: WorkspaceAppFactoryJobViewModel;
}): ReactElement {
  const statusLabel = copy.t(job.statusLabelKey);
  if (job.status === "generating") {
    return (
      <span
        aria-label={statusLabel}
        className="inline-flex size-3 shrink-0 items-center justify-center"
        role="status"
        title={statusLabel}
      >
        <Spinner
          className="text-[var(--text-tertiary)]"
          size={12}
          strokeWidth={2}
          trackColor="var(--line-2)"
        />
      </span>
    );
  }
  return (
    <Badge variant={job.status === "failed" ? "destructive" : "secondary"}>
      {statusLabel}
    </Badge>
  );
}
