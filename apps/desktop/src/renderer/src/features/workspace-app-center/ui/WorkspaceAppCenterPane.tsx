import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  WorkspaceAppCenterApp,
  WorkspaceAppCenterViewState,
  WorkspaceAppManifest,
  WorkspaceAppRecord,
  WorkspaceAppRuntimeState
} from "@tutti-os/workspace-app-center";
import {
  createAppCenterViewModel,
  workspaceAppManifestSchemaVersion
} from "@tutti-os/workspace-app-center";
import { createAppCenterI18nRuntime } from "@tutti-os/workspace-app-center/i18n";
import type {
  AppCenterAppTab,
  AppCenterFactoryProviderConfiguration,
  AppCenterFactoryProviderOption
} from "@tutti-os/workspace-app-center/ui";
import { AppCenterPanel } from "@tutti-os/workspace-app-center/ui";
import { agentGuiDockIconUrls } from "@tutti-os/agent-gui";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import { useService } from "@tutti-os/infra/di";
import {
  IAgentProviderStatusService,
  requestWorkspaceAgentGuiLaunch
} from "@renderer/features/workspace-agent";
import { normalizeDesktopAgentGUIProvider } from "@renderer/features/workspace-agent/desktopAgentGUINodeState";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import {
  isWorkspaceAgentGuiComingSoonProvider,
  resolveWorkspaceAgentGuiLabel,
  workspaceAgentGuiProviders
} from "@renderer/features/workspace-workbench/services/workspaceAgentProviderCatalog";
import { shouldShowWorkspaceApp } from "../services/workspaceAppVisibility.ts";
import { useWorkspaceAppCenterService } from "./useWorkspaceAppCenterService.ts";

const comingSoonWorkspaceAppDefinitions = [
  {
    appId: "product-competition",
    displayTagKeys: [
      "appCenter.comingSoonTags.productCompetition.primary",
      "appCenter.comingSoonTags.productCompetition.secondary",
      "appCenter.comingSoonTags.productCompetition.tertiary"
    ],
    tags: ["coming-soon", "product", "design"]
  },
  {
    appId: "design-review",
    displayTagKeys: [
      "appCenter.comingSoonTags.designReview.primary",
      "appCenter.comingSoonTags.designReview.secondary",
      "appCenter.comingSoonTags.designReview.tertiary"
    ],
    tags: ["coming-soon", "product", "design"]
  },
  {
    appId: "group-chat",
    displayTagKeys: [
      "appCenter.comingSoonTags.groupChat.primary",
      "appCenter.comingSoonTags.groupChat.secondary",
      "appCenter.comingSoonTags.groupChat.tertiary"
    ],
    tags: ["coming-soon", "productivity", "chat", "team"]
  },
  {
    appId: "ai-ppt",
    displayTagKeys: [
      "appCenter.comingSoonTags.aiPpt.primary",
      "appCenter.comingSoonTags.aiPpt.secondary",
      "appCenter.comingSoonTags.aiPpt.tertiary"
    ],
    tags: ["coming-soon", "office", "presentation"]
  },
  {
    appId: "ai-document",
    displayTagKeys: [
      "appCenter.comingSoonTags.aiDocument.primary",
      "appCenter.comingSoonTags.aiDocument.secondary",
      "appCenter.comingSoonTags.aiDocument.tertiary"
    ],
    tags: ["coming-soon", "office", "document"]
  },
  {
    appId: "ai-sheet",
    displayTagKeys: [
      "appCenter.comingSoonTags.aiSheet.primary",
      "appCenter.comingSoonTags.aiSheet.secondary",
      "appCenter.comingSoonTags.aiSheet.tertiary"
    ],
    tags: ["coming-soon", "office", "spreadsheet"]
  },
  {
    appId: "open-cut",
    displayTagKeys: [
      "appCenter.comingSoonTags.openCut.primary",
      "appCenter.comingSoonTags.openCut.secondary",
      "appCenter.comingSoonTags.openCut.tertiary"
    ],
    tags: ["coming-soon", "content", "creation", "video", "timeline", "editor"]
  },
  {
    appId: "calendar",
    displayTagKeys: [
      "appCenter.comingSoonTags.calendar.primary",
      "appCenter.comingSoonTags.calendar.secondary",
      "appCenter.comingSoonTags.calendar.tertiary"
    ],
    tags: ["coming-soon", "productivity", "calendar", "schedule"]
  },
  {
    appId: "document-summarizer",
    displayTagKeys: [
      "appCenter.comingSoonTags.documentSummarizer.primary",
      "appCenter.comingSoonTags.documentSummarizer.secondary",
      "appCenter.comingSoonTags.documentSummarizer.tertiary"
    ],
    tags: ["coming-soon", "productivity", "summary", "document"]
  }
] as const;

export function WorkspaceAppCenterPane({
  resolveAppIconUrl,
  restoredViewState = null,
  workspaceId
}: {
  resolveAppIconUrl?: (appId: string) => string | null;
  restoredViewState?: WorkspaceAppCenterViewState | null;
  workspaceId: string;
}) {
  const { service, state } = useWorkspaceAppCenterService();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const agentProviderSnapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => agentProviderStatusService.getSnapshot()
  );
  const { i18n, locale } = useTranslation();
  const copy = useMemo(() => createAppCenterI18nRuntime(i18n), [i18n]);
  const normalizedWorkspaceId = workspaceId.trim();
  const storedViewState = normalizedWorkspaceId
    ? state.viewStateByWorkspaceId[normalizedWorkspaceId]
    : undefined;
  const viewState =
    storedViewState ?? service.getViewState(workspaceId, restoredViewState);
  useEffect(() => {
    void service.refreshCatalog(workspaceId);
  }, [service, workspaceId]);
  useEffect(() => {
    void agentProviderStatusService.ensureLoaded({
      providers: [...workspaceAgentGuiProviders]
    });
  }, [agentProviderStatusService]);
  useEffect(() => {
    if (!state.error) {
      return;
    }
    const error = service.consumeError();
    if (error) {
      Toast.Error(error);
    }
  }, [service, state.error]);
  const factoryProviderOptions = useMemo(
    () =>
      resolveAppCenterReadyAgentProviderOptions(agentProviderSnapshot.statuses),
    [agentProviderSnapshot.statuses]
  );
  const catalogPanelStatus =
    state.catalogStatus === "loading" || state.catalogStatus === "failed"
      ? state.catalogStatus
      : undefined;
  const comingSoonApps = useMemo(
    () => createComingSoonWorkspaceApps(i18n, locale),
    [i18n, locale]
  );
  const categoryLabels = useMemo(
    () => createWorkspaceAppCategoryLabels(i18n),
    [i18n]
  );
  const loadFactoryProviderConfiguration = useMemo(
    () =>
      async (
        provider: string
      ): Promise<AppCenterFactoryProviderConfiguration> => {
        return service.getFactoryProviderConfiguration(provider);
      },
    [service]
  );
  const viewModel = useMemo(
    () =>
      createAppCenterViewModel({
        apps: withComingSoonWorkspaceApps(state.apps, comingSoonApps)
          .filter((app) => shouldShowWorkspaceApp(app.appId))
          .map((app) =>
            toWorkspaceAppRecord(
              withWorkspaceAppIconOverride(app, resolveAppIconUrl),
              resolveWorkspaceAppCategory(app.appId, categoryLabels)
            )
          ),
        factoryJobs: state.factoryJobs.map((job) => ({
          agentSessionId: job.agentSessionId,
          appId: job.appId,
          displayName: job.displayName,
          failureReason: job.failureReason,
          jobId: job.jobId,
          prompt: job.prompt,
          provider: job.provider,
          publishedVersion: job.publishedVersion,
          status: job.status,
          updatedAtUnixMs: job.updatedAtUnixMs,
          validationResult: job.validationResult
        })),
        locale,
        replaceableIconAppIds: state.apps
          .filter((app) => app.source === "generated")
          .map((app) => app.appId),
        runtimeStates: withComingSoonWorkspaceApps(state.apps, comingSoonApps)
          .filter((app) => shouldShowWorkspaceApp(app.appId))
          .map((app) =>
            toWorkspaceAppRuntimeState(
              withWorkspaceAppIconOverride(app, resolveAppIconUrl)
            )
          )
      }),
    [
      categoryLabels,
      comingSoonApps,
      locale,
      resolveAppIconUrl,
      state.apps,
      state.factoryJobs
    ]
  );

  return (
    <AppCenterPanel
      actions={{
        cancelFactoryJob: (jobId) =>
          service.cancelFactoryJob({ jobId, workspaceId }),
        createFactoryJob: (input) =>
          service.createFactoryJob({ ...input, workspaceId }),
        deleteFactoryJob: (jobId) =>
          service.deleteFactoryJob({ jobId, workspaceId }),
        deleteApp: (appId) => service.deleteApp({ appId, workspaceId }),
        exportApp: (appId) => service.exportApp({ appId, workspaceId }),
        fixFactoryJob: (jobId, prompt) =>
          service.fixFactoryJob({ jobId, prompt, workspaceId }),
        importApp: () => service.importApp({ workspaceId }),
        installApp: (appId) => service.installApp({ appId, workspaceId }),
        openApp: (appId) => service.openApp({ appId, workspaceId }),
        openAppFolder: (appId) => service.openAppFolder({ appId, workspaceId }),
        openAppPackageFolder: (appId) =>
          service.openAppPackageFolder({ appId, workspaceId }),
        openFactoryJobAgentSession: async (agentSessionId, provider) => {
          await requestWorkspaceAgentGuiLaunch({
            agentSessionId,
            provider: normalizeDesktopAgentGUIProvider(provider),
            workspaceId
          });
        },
        modifyAppWithAgent: async (jobId, agentSessionId, provider) => {
          const preparedJob = await service.prepareFactoryJobModification({
            jobId,
            workspaceId
          });
          if (!preparedJob) {
            return;
          }
          await requestWorkspaceAgentGuiLaunch({
            agentSessionId: preparedJob.agentSessionId ?? agentSessionId,
            provider: normalizeDesktopAgentGUIProvider(
              preparedJob.provider ?? provider
            ),
            workspaceId
          });
        },
        publishFactoryJob: (jobId) =>
          service.publishFactoryJob({ jobId, workspaceId }),
        refreshCatalog: () => service.refreshCatalog(workspaceId),
        retryFactoryValidation: (jobId) =>
          service.retryFactoryValidation({ jobId, workspaceId }),
        retryApp: (appId) => service.retryApp({ appId, workspaceId }),
        replaceAppIcon: (appId) =>
          service.replaceAppIcon({ appId, workspaceId }),
        updateApp: (appId, trigger) =>
          service.updateApp({ appId, trigger, workspaceId }),
        uninstallApp: (appId) => service.uninstallApp({ appId, workspaceId })
      }}
      activeAppTab={viewState.activeAppTab}
      catalogStatus={catalogPanelStatus}
      copy={copy}
      defaultAgentProvider={agentProviderSnapshot.defaultProvider}
      loadProviderConfiguration={loadFactoryProviderConfiguration}
      onActiveAppTabChange={(activeAppTab: AppCenterAppTab) => {
        service.setViewState({
          state: { activeAppTab },
          workspaceId
        });
      }}
      providerErrorMessage={agentProviderSnapshot.error}
      providerLoading={agentProviderSnapshot.isLoading}
      providerOptions={factoryProviderOptions}
      viewModel={viewModel}
    />
  );
}

function createComingSoonWorkspaceApps(
  i18n: { readonly t: (key: string) => string },
  locale: string
): readonly WorkspaceAppCenterApp[] {
  return [
    createComingSoonWorkspaceApp({
      description: i18n.t(
        "appCenter.comingSoonApps.productCompetition.description"
      ),
      definition: comingSoonWorkspaceAppDefinitions[0],
      locale,
      name: i18n.t("appCenter.comingSoonApps.productCompetition.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.designReview.description"),
      definition: comingSoonWorkspaceAppDefinitions[1],
      locale,
      name: i18n.t("appCenter.comingSoonApps.designReview.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.groupChat.description"),
      definition: comingSoonWorkspaceAppDefinitions[2],
      locale,
      name: i18n.t("appCenter.comingSoonApps.groupChat.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.aiPpt.description"),
      definition: comingSoonWorkspaceAppDefinitions[3],
      locale,
      name: i18n.t("appCenter.comingSoonApps.aiPpt.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.aiDocument.description"),
      definition: comingSoonWorkspaceAppDefinitions[4],
      locale,
      name: i18n.t("appCenter.comingSoonApps.aiDocument.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.aiSheet.description"),
      definition: comingSoonWorkspaceAppDefinitions[5],
      locale,
      name: i18n.t("appCenter.comingSoonApps.aiSheet.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.openCut.description"),
      definition: comingSoonWorkspaceAppDefinitions[6],
      locale,
      name: i18n.t("appCenter.comingSoonApps.openCut.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t("appCenter.comingSoonApps.calendar.description"),
      definition: comingSoonWorkspaceAppDefinitions[7],
      locale,
      name: i18n.t("appCenter.comingSoonApps.calendar.name"),
      t: i18n.t
    }),
    createComingSoonWorkspaceApp({
      description: i18n.t(
        "appCenter.comingSoonApps.documentSummarizer.description"
      ),
      definition: comingSoonWorkspaceAppDefinitions[8],
      locale,
      name: i18n.t("appCenter.comingSoonApps.documentSummarizer.name"),
      t: i18n.t
    })
  ];
}

function createComingSoonWorkspaceApp(input: {
  readonly definition: (typeof comingSoonWorkspaceAppDefinitions)[number];
  readonly description: string;
  readonly locale: string;
  readonly name: string;
  readonly t: (key: string) => string;
}): WorkspaceAppCenterApp {
  return {
    appId: input.definition.appId,
    createdAtUnixMs: 0,
    description: input.description,
    enabled: false,
    exportable: false,
    installed: false,
    localizations: [
      {
        description: input.description,
        locale: input.locale,
        name: input.name,
        tags: input.definition.displayTagKeys.map((key) => input.t(key))
      }
    ],
    minimizeBehavior: "keep-mounted",
    name: input.name,
    runtimeStatus: "idle",
    source: "builtin",
    stateRevision: 0,
    tags: input.definition.tags,
    updateAvailable: false
  };
}

function withComingSoonWorkspaceApps(
  apps: readonly WorkspaceAppCenterApp[],
  comingSoonApps: readonly WorkspaceAppCenterApp[]
): readonly WorkspaceAppCenterApp[] {
  const existingAppIds = new Set(apps.map((app) => app.appId));
  const missingComingSoonApps = comingSoonApps.filter(
    (app) => !existingAppIds.has(app.appId)
  );
  return missingComingSoonApps.length > 0
    ? [...apps, ...missingComingSoonApps]
    : apps;
}

function withWorkspaceAppIconOverride(
  app: WorkspaceAppCenterApp,
  resolveAppIconUrl?: (appId: string) => string | null
): WorkspaceAppCenterApp {
  const overrideIconUrl = resolveAppIconUrl?.(app.appId);
  return overrideIconUrl ? { ...app, iconUrl: overrideIconUrl } : app;
}

function createWorkspaceAppCategoryLabels(i18n: {
  readonly t: (key: string) => string;
}): Record<WorkspaceAppCategoryID, string> {
  return {
    contentCreation: i18n.t("appCenter.categories.contentCreation"),
    office: i18n.t("appCenter.categories.office"),
    productDesign: i18n.t("appCenter.categories.productDesign"),
    tools: i18n.t("appCenter.categories.tools")
  };
}

type WorkspaceAppCategoryID =
  | "contentCreation"
  | "office"
  | "productDesign"
  | "tools";

function resolveWorkspaceAppCategory(
  appId: string,
  labels: Record<WorkspaceAppCategoryID, string>
): string | null {
  switch (appId.trim().toLowerCase()) {
    case "product-competition":
    case "daily-product-radar":
    case "daily-tech-radar":
    case "radar":
    case "design-review":
    case "vibe-design":
      return labels.productDesign;
    case "ai-ppt":
    case "ai-document":
    case "ai-sheet":
      return labels.office;
    case "ai-media-canvas":
    case "media-canvas":
    case "open-cut":
      return labels.contentCreation;
    case "automation":
    case "group-chat":
    case "issue":
    case "issues":
    case "issue-manager":
    case "workspace-issue":
    case "workspace-issue-manager":
    case "calendar":
    case "document-summarizer":
      return labels.tools;
    default:
      return null;
  }
}

function resolveAppCenterReadyAgentProviderOptions(
  statuses: readonly AgentProviderStatus[]
): readonly AppCenterFactoryProviderOption[] {
  const readyProviders = new Set(
    statuses
      .filter((status) => status.availability.status === "ready")
      .map((status) => status.provider)
  );

  return workspaceAgentGuiProviders
    .filter(
      (provider) =>
        readyProviders.has(provider) &&
        !isWorkspaceAgentGuiComingSoonProvider(provider)
    )
    .map((provider) => ({
      iconUrl: agentGuiDockIconUrls[provider],
      label: resolveWorkspaceAgentGuiLabel(provider),
      provider
    }));
}

function toWorkspaceAppRecord(
  app: WorkspaceAppCenterApp,
  category: string | null
): WorkspaceAppRecord {
  const manifest = toWorkspaceAppManifest(app);
  return {
    availableIconUrl: app.availableIconUrl,
    availableVersion: app.availableVersion,
    catalog: {
      localizations: (app.localizations ?? []).map((localization) => ({
        description: localization.description,
        locale: localization.locale,
        name: localization.name,
        tags: localization.tags
      })),
      manifest,
      source: {
        kind: app.source === "builtin" ? "bundled" : "local"
      }
    },
    category,
    createdAtUnixMs: app.createdAtUnixMs,
    install: app.installed
      ? {
          appId: app.appId
        }
      : null,
    manifest,
    updateAvailable: app.updateAvailable
  };
}

function toWorkspaceAppManifest(
  app: WorkspaceAppCenterApp
): WorkspaceAppManifest {
  return {
    appId: app.appId,
    description: app.description ?? "",
    runtime: {
      bootstrap: "bootstrap.sh",
      healthcheckPath: "/"
    },
    ...(app.iconUrl
      ? {
          icon: {
            type: "asset" as const,
            src: app.iconUrl
          }
        }
      : {}),
    name: app.name,
    schemaVersion: workspaceAppManifestSchemaVersion,
    tags: app.tags ?? [],
    version: app.version ?? "0.1.0",
    window: {
      minimizeBehavior: app.minimizeBehavior
    }
  };
}

function toWorkspaceAppRuntimeState(
  app: WorkspaceAppCenterApp
): WorkspaceAppRuntimeState {
  const cliIssue =
    app.cli?.status === "warning" || app.cli?.status === "error"
      ? app.cli.issues[0]
      : null;
  return {
    appId: app.appId,
    ...(cliIssue
      ? {
          error: {
            code: cliIssue.code,
            message: cliIssue.message
          }
        }
      : {}),
    status: app.runtimeStatus
  };
}
