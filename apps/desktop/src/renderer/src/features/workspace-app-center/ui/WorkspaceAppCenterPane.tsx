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

const catalogAppDisplayDefinitions = [
  {
    appIds: ["ai-media-canvas", "media-canvas"],
    descriptionKey: "appCenter.catalogApps.aiMediaCanvas.description",
    nameKey: "appCenter.catalogApps.aiMediaCanvas.name"
  },
  {
    appIds: ["automation"],
    descriptionKey: "appCenter.catalogApps.automation.description",
    nameKey: "appCenter.catalogApps.automation.name"
  },
  {
    appIds: ["daily-product-radar", "daily-tech-radar", "radar"],
    descriptionKey: "appCenter.catalogApps.dailyProductRadar.description",
    nameKey: "appCenter.catalogApps.dailyProductRadar.name"
  },
  {
    appIds: ["group-chat"],
    descriptionKey: "appCenter.catalogApps.groupChat.description",
    nameKey: "appCenter.catalogApps.groupChat.name"
  },
  {
    appIds: ["vibe-design"],
    descriptionKey: "appCenter.catalogApps.vibeDesign.description",
    nameKey: "appCenter.catalogApps.vibeDesign.name"
  }
] as const;

type CatalogAppDisplayDefinition = {
  descriptionKey: string;
  nameKey: string;
};

const catalogAppDisplayById = new Map<string, CatalogAppDisplayDefinition>(
  catalogAppDisplayDefinitions.flatMap((definition) =>
    definition.appIds.map(
      (appId) =>
        [
          appId,
          {
            descriptionKey: definition.descriptionKey,
            nameKey: definition.nameKey
          }
        ] as const
    )
  )
);

const comingSoonWorkspaceAppDefinitions = [
  {
    appId: "ai-ppt",
    descriptionKey: "appCenter.comingSoonApps.aiPpt.description",
    nameKey: "appCenter.comingSoonApps.aiPpt.name",
    tags: ["coming-soon", "office", "presentation"]
  },
  {
    appId: "ai-document",
    descriptionKey: "appCenter.comingSoonApps.aiDocument.description",
    nameKey: "appCenter.comingSoonApps.aiDocument.name",
    tags: ["coming-soon", "office", "document"]
  },
  {
    appId: "ai-sheet",
    descriptionKey: "appCenter.comingSoonApps.aiSheet.description",
    nameKey: "appCenter.comingSoonApps.aiSheet.name",
    tags: ["coming-soon", "office", "spreadsheet"]
  },
  {
    appId: "open-cut",
    descriptionKey: "appCenter.comingSoonApps.openCut.description",
    nameKey: "appCenter.comingSoonApps.openCut.name",
    tags: ["coming-soon", "content", "creation", "video", "timeline", "editor"]
  },
  {
    appId: "product-competition",
    descriptionKey: "appCenter.comingSoonApps.productCompetition.description",
    nameKey: "appCenter.comingSoonApps.productCompetition.name",
    tags: ["coming-soon", "product", "design"]
  },
  {
    appId: "design-review",
    descriptionKey: "appCenter.comingSoonApps.designReview.description",
    nameKey: "appCenter.comingSoonApps.designReview.name",
    tags: ["coming-soon", "product", "design"]
  },
  {
    appId: "calendar",
    descriptionKey: "appCenter.comingSoonApps.calendar.description",
    nameKey: "appCenter.comingSoonApps.calendar.name",
    tags: ["coming-soon", "productivity", "calendar", "schedule"]
  },
  {
    appId: "document-summarizer",
    descriptionKey: "appCenter.comingSoonApps.documentSummarizer.description",
    nameKey: "appCenter.comingSoonApps.documentSummarizer.name",
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
  const viewModel = useMemo(() => {
    const recommendedApps = withComingSoonWorkspaceApps(
      state.apps,
      comingSoonApps
    )
      .map((app) => withWorkspaceAppDisplayOverride(app, i18n, locale))
      .filter((app) => shouldShowWorkspaceApp(app.appId));

    return createAppCenterViewModel({
      apps: recommendedApps.map((app) =>
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
      runtimeStates: recommendedApps.map((app) =>
        toWorkspaceAppRuntimeState(
          withWorkspaceAppIconOverride(app, resolveAppIconUrl)
        )
      )
    });
  }, [
    categoryLabels,
    comingSoonApps,
    i18n,
    locale,
    resolveAppIconUrl,
    state.apps,
    state.factoryJobs
  ]);

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
  return comingSoonWorkspaceAppDefinitions.map((definition) =>
    createComingSoonWorkspaceApp({
      description: i18n.t(definition.descriptionKey),
      definition,
      locale,
      name: i18n.t(definition.nameKey),
      t: i18n.t
    })
  );
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
        tags: []
      }
    ],
    minimizeBehavior: "keep-mounted",
    name: input.name,
    references: { listSupported: false },
    runtimeStatus: "idle",
    source: "builtin",
    stateRevision: 0,
    tags: input.definition.tags,
    updateAvailable: false
  };
}

function withWorkspaceAppDisplayOverride(
  app: WorkspaceAppCenterApp,
  i18n: { readonly t: (key: string) => string },
  locale: string
): WorkspaceAppCenterApp {
  const definition = catalogAppDisplayById.get(app.appId.trim().toLowerCase());
  if (!definition) {
    return app;
  }
  const name = i18n.t(definition.nameKey);
  const description = i18n.t(definition.descriptionKey);
  return {
    ...app,
    description,
    name,
    localizations: [
      {
        description,
        locale,
        name,
        tags: []
      }
    ]
  };
}

function withComingSoonWorkspaceApps(
  apps: readonly WorkspaceAppCenterApp[],
  comingSoonApps: readonly WorkspaceAppCenterApp[]
): readonly WorkspaceAppCenterApp[] {
  const comingSoonByAppId = new Map(
    comingSoonApps.map((app) => [app.appId, app] as const)
  );
  const mergedApps = apps.map((app) => {
    const comingSoonApp = comingSoonByAppId.get(app.appId);
    if (!comingSoonApp) {
      return app;
    }
    comingSoonByAppId.delete(app.appId);
    return {
      ...comingSoonApp,
      ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
      ...(app.availableIconUrl
        ? { availableIconUrl: app.availableIconUrl }
        : {})
    };
  });
  const remainingComingSoonApps = [...comingSoonByAppId.values()];
  return remainingComingSoonApps.length > 0
    ? [...mergedApps, ...remainingComingSoonApps]
    : mergedApps;
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
          ...(app.installationId?.trim()
            ? { installationId: app.installationId.trim() }
            : {}),
          appId: app.appId,
          version: app.version ?? null
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
    ...(app.runtimeId?.trim() ? { runtimeId: app.runtimeId.trim() } : {}),
    ...(app.installationId?.trim()
      ? { installationId: app.installationId.trim() }
      : {}),
    appId: app.appId,
    launchUrl: app.launchUrl ?? null,
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
