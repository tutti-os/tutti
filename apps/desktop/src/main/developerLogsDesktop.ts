import { app } from "electron";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import type { ExportDeveloperLogsResult } from "../shared/contracts/ipc.ts";
import {
  createDeveloperLogsService,
  type DeveloperLogsAppCenterSnapshot
} from "./developerLogs.ts";
import type { DeveloperLogsAgentSessionRecord } from "./developerLogsAgentSessions.ts";
import { getSystemDesktopLocale } from "./desktopLocale.ts";
import type { DesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import { resolveDesktopDefaultsFromEnv } from "./defaults.ts";
import { flushDesktopLogger, getDesktopLogger } from "./logging.ts";
import { resolveDesktopDaemonEndpoint } from "./transport/paths.ts";
import { exportDeveloperLogsToDefaultDownloadsPathAndNotify } from "./developerLogsExportDialog.ts";

export function createDesktopDeveloperLogsService(
  preferences: DesktopHostPreferencesState,
  tuttidClient?: Pick<
    TuttidClient,
    | "listWorkspaceAgentSessionMessages"
    | "listWorkspaceAgentSessions"
    | "listWorkspaceAppFactoryJobs"
    | "listWorkspaceApps"
    | "listWorkspaces"
  >
): ReturnType<typeof createDeveloperLogsService> {
  return createDeveloperLogsService({
    agentSessionsProvider: tuttidClient
      ? () => listDeveloperLogsAgentSessions(tuttidClient)
      : undefined,
    appCenterSnapshotProvider: tuttidClient
      ? () => buildDeveloperLogsAppCenterSnapshot(tuttidClient)
      : undefined,
    defaults: resolveDesktopDefaultsFromEnv(),
    desktopVersion: app.getVersion(),
    flushLogs: flushDesktopLogger,
    getDownloadsPath: () => app.getPath("downloads"),
    persistedLocale: preferences.getLocale(),
    preferredSystemLanguages:
      typeof app.getPreferredSystemLanguages === "function"
        ? app.getPreferredSystemLanguages()
        : null,
    systemLocale: getSystemDesktopLocale(),
    transportSnapshot: resolveDesktopDaemonEndpoint()
  });
}

export async function exportDesktopDeveloperLogsAndNotify(
  preferences: DesktopHostPreferencesState,
  tuttidClient?: Pick<
    TuttidClient,
    | "listWorkspaceAgentSessionMessages"
    | "listWorkspaceAgentSessions"
    | "listWorkspaceAppFactoryJobs"
    | "listWorkspaceApps"
    | "listWorkspaces"
  >
): Promise<ExportDeveloperLogsResult> {
  const defaults = resolveDesktopDefaultsFromEnv();
  getDesktopLogger().info("developer logs export requested", {
    logsDir: defaults.state.logsDir
  });
  await flushDesktopLogger();

  return exportDeveloperLogsToDefaultDownloadsPathAndNotify({
    locale: preferences.getLocale(),
    service: createDesktopDeveloperLogsService(preferences, tuttidClient)
  });
}

async function listDeveloperLogsAgentSessions(
  tuttidClient: Pick<
    TuttidClient,
    | "listWorkspaceAgentSessionMessages"
    | "listWorkspaceAgentSessions"
    | "listWorkspaceAppFactoryJobs"
    | "listWorkspaceApps"
    | "listWorkspaces"
  >
): Promise<DeveloperLogsAgentSessionRecord[]> {
  const workspaces = await tuttidClient.listWorkspaces();
  const sessionPages = await Promise.all(
    workspaces.workspaces.map((workspace) =>
      tuttidClient.listWorkspaceAgentSessions(workspace.id).catch(() => ({
        hasMore: false,
        sessions: [],
        workspaceId: workspace.id
      }))
    )
  );

  const sessions = sessionPages.flatMap((page) =>
    page.sessions.flatMap((session) => {
      if (
        resolveAgentGUIProviderCatalogIdentity(session.provider)?.desktop
          .developerLogs !== true
      ) {
        return [];
      }
      const providerSessionID = session.providerSessionId?.trim() ?? "";
      if (!providerSessionID) {
        return [];
      }
      return [
        {
          agentSessionID: session.id,
          provider:
            session.provider as DeveloperLogsAgentSessionRecord["provider"],
          providerSessionID,
          session,
          updatedAtUnixMS: session.updatedAtUnixMs,
          workspaceID: page.workspaceId
        }
      ];
    })
  );

  const selectedSessions = selectRecentAgentSessionsByProvider(sessions);
  const records = await Promise.all(
    selectedSessions.map(
      async (session): Promise<DeveloperLogsAgentSessionRecord | null> => {
        const messages = await tuttidClient
          .listWorkspaceAgentSessionMessages(
            session.workspaceID,
            session.agentSessionID,
            { limit: 500, order: "asc" }
          )
          .catch(() => null);
        if (!messages) {
          return null;
        }
        return {
          ...session,
          hasMoreMessages: messages.hasMore,
          latestMessageVersion: messages.latestVersion,
          messages: messages.messages
        } satisfies DeveloperLogsAgentSessionRecord;
      }
    )
  );
  return records.filter(
    (record): record is DeveloperLogsAgentSessionRecord => record !== null
  );
}

async function buildDeveloperLogsAppCenterSnapshot(
  tuttidClient: Pick<
    TuttidClient,
    "listWorkspaceAppFactoryJobs" | "listWorkspaceApps" | "listWorkspaces"
  >
): Promise<DeveloperLogsAppCenterSnapshot> {
  const workspaces = await tuttidClient.listWorkspaces();
  const workspaceSnapshots: DeveloperLogsAppCenterSnapshot["workspaces"] =
    await Promise.all(
      workspaces.workspaces.map(async (workspace) => {
        const [apps, factoryJobs] = await Promise.all([
          tuttidClient.listWorkspaceApps(workspace.id).catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
            workspaceId: workspace.id
          })),
          tuttidClient
            .listWorkspaceAppFactoryJobs(workspace.id)
            .catch((error) => ({
              error: error instanceof Error ? error.message : String(error),
              workspaceId: workspace.id
            }))
        ]);
        return {
          appFactoryJobsResponse: factoryJobs,
          appsResponse: apps,
          workspaceId: workspace.id
        };
      })
    );

  return {
    workspaces: workspaceSnapshots
  };
}

function selectRecentAgentSessionsByProvider(
  sessions: Array<
    Omit<
      DeveloperLogsAgentSessionRecord,
      "hasMoreMessages" | "latestMessageVersion" | "messages"
    >
  >
): Array<
  Omit<
    DeveloperLogsAgentSessionRecord,
    "hasMoreMessages" | "latestMessageVersion" | "messages"
  >
> {
  const byProvider = new Map<
    DeveloperLogsAgentSessionRecord["provider"],
    Array<
      Omit<
        DeveloperLogsAgentSessionRecord,
        "hasMoreMessages" | "latestMessageVersion" | "messages"
      >
    >
  >();
  for (const session of sessions) {
    const providerSessions = byProvider.get(session.provider) ?? [];
    providerSessions.push(session);
    byProvider.set(session.provider, providerSessions);
  }

  return [...byProvider.values()].flatMap((providerSessions) =>
    providerSessions
      .sort(
        (left, right) =>
          right.updatedAtUnixMS - left.updatedAtUnixMS ||
          left.agentSessionID.localeCompare(right.agentSessionID)
      )
      .slice(0, 10)
  );
}
