import {
  cancelWorkspaceAppFactoryJob,
  createWorkspaceAppFactoryJob,
  deleteWorkspaceApp,
  deleteWorkspaceAppFactoryJob,
  exportWorkspaceApp,
  fixWorkspaceAppFactoryJob,
  getWorkspaceAppFactoryJob,
  importWorkspaceApp,
  installWorkspaceApp,
  launchWorkspaceApp,
  listWorkspaceAppReferences,
  listWorkspaceAppFactoryJobs,
  listWorkspaceApps,
  prepareWorkspaceAppFactoryJobModification,
  publishWorkspaceAppFactoryJob,
  refreshWorkspaceAppCatalog,
  replaceWorkspaceAppIcon,
  retryWorkspaceApp,
  retryWorkspaceAppFactoryJobValidation,
  rollbackWorkspaceApp,
  startEnabledWorkspaceApps,
  stopAllWorkspaceApps,
  uninstallWorkspaceApp
} from "./generated/index.ts";
import type { Client } from "./generated/client/index.ts";
import { unwrapData } from "./tuttidClientResponse.ts";
import type { TuttidClient } from "./tuttidClientTypes.ts";

type WorkspaceAppsClient = Pick<
  TuttidClient,
  | "cancelWorkspaceAppFactoryJob"
  | "createWorkspaceAppFactoryJob"
  | "deleteWorkspaceApp"
  | "deleteWorkspaceAppFactoryJob"
  | "exportWorkspaceApp"
  | "fixWorkspaceAppFactoryJob"
  | "getWorkspaceAppFactoryJob"
  | "importWorkspaceApp"
  | "installWorkspaceApp"
  | "launchWorkspaceApp"
  | "listWorkspaceAppReferences"
  | "listWorkspaceAppFactoryJobs"
  | "listWorkspaceApps"
  | "prepareWorkspaceAppFactoryJobModification"
  | "publishWorkspaceAppFactoryJob"
  | "refreshWorkspaceAppCatalog"
  | "replaceWorkspaceAppIcon"
  | "retryWorkspaceApp"
  | "retryWorkspaceAppFactoryJobValidation"
  | "rollbackWorkspaceApp"
  | "startEnabledWorkspaceApps"
  | "stopAllWorkspaceApps"
  | "uninstallWorkspaceApp"
>;

export function createWorkspaceAppsClient(client: Client): WorkspaceAppsClient {
  return {
    async listWorkspaceApps(workspaceID) {
      const response = await listWorkspaceApps({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "List workspace apps request failed.");
    },
    async listWorkspaceAppReferences(workspaceID, appID, request) {
      const response = await listWorkspaceAppReferences({
        client,
        body: request,
        path: { appID, workspaceID }
      });
      return unwrapData(
        response,
        "List workspace app references request failed."
      );
    },
    async refreshWorkspaceAppCatalog(workspaceID) {
      const response = await refreshWorkspaceAppCatalog({
        client,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Refresh workspace app catalog request failed."
      );
    },
    async installWorkspaceApp(workspaceID, appID, request) {
      const response = await installWorkspaceApp({
        ...(request ? { body: request } : {}),
        client,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Install workspace app request failed.").app;
    },
    async exportWorkspaceApp(workspaceID, appID, request) {
      const response = await exportWorkspaceApp({
        client,
        body: request,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Export workspace app request failed.");
    },
    async importWorkspaceApp(workspaceID, request) {
      const response = await importWorkspaceApp({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(response, "Import workspace app request failed.").app;
    },
    async uninstallWorkspaceApp(workspaceID, appID) {
      const response = await uninstallWorkspaceApp({
        client,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Uninstall workspace app request failed.")
        .app;
    },
    async deleteWorkspaceApp(workspaceID, appID) {
      const response = await deleteWorkspaceApp({
        client,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Delete workspace app request failed.");
    },
    async launchWorkspaceApp(workspaceID, appID) {
      const response = await launchWorkspaceApp({
        client,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Launch workspace app request failed.").app;
    },
    async retryWorkspaceApp(workspaceID, appID) {
      const response = await retryWorkspaceApp({
        client,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Retry workspace app request failed.").app;
    },
    async rollbackWorkspaceApp(workspaceID, appID, request) {
      const response = await rollbackWorkspaceApp({
        client,
        body: request,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Rollback workspace app request failed.").app;
    },
    async replaceWorkspaceAppIcon(workspaceID, appID, request) {
      const response = await replaceWorkspaceAppIcon({
        client,
        body: request,
        path: { appID, workspaceID }
      });
      return unwrapData(response, "Replace workspace app icon request failed.")
        .app;
    },
    async startEnabledWorkspaceApps(workspaceID) {
      const response = await startEnabledWorkspaceApps({
        client,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Start enabled workspace apps request failed."
      );
    },
    async stopAllWorkspaceApps(workspaceID) {
      const response = await stopAllWorkspaceApps({
        client,
        path: { workspaceID }
      });
      return unwrapData(response, "Stop workspace apps request failed.");
    },
    async listWorkspaceAppFactoryJobs(workspaceID) {
      const response = await listWorkspaceAppFactoryJobs({
        client,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "List workspace app factory jobs request failed."
      );
    },
    async createWorkspaceAppFactoryJob(workspaceID, request) {
      const response = await createWorkspaceAppFactoryJob({
        client,
        body: request,
        path: { workspaceID }
      });
      return unwrapData(
        response,
        "Create workspace app factory job request failed."
      ).job;
    },
    async getWorkspaceAppFactoryJob(workspaceID, jobID) {
      const response = await getWorkspaceAppFactoryJob({
        client,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Get workspace app factory job request failed."
      ).job;
    },
    async deleteWorkspaceAppFactoryJob(workspaceID, jobID) {
      const response = await deleteWorkspaceAppFactoryJob({
        client,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Delete workspace app factory job request failed."
      );
    },
    async cancelWorkspaceAppFactoryJob(workspaceID, jobID) {
      const response = await cancelWorkspaceAppFactoryJob({
        client,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Cancel workspace app factory job request failed."
      ).job;
    },
    async retryWorkspaceAppFactoryJobValidation(workspaceID, jobID) {
      const response = await retryWorkspaceAppFactoryJobValidation({
        client,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Retry workspace app factory validation request failed."
      ).job;
    },
    async fixWorkspaceAppFactoryJob(workspaceID, jobID, request) {
      const response = await fixWorkspaceAppFactoryJob({
        client,
        body: request,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Fix workspace app factory job request failed."
      ).job;
    },
    async prepareWorkspaceAppFactoryJobModification(workspaceID, jobID) {
      const response = await prepareWorkspaceAppFactoryJobModification({
        client,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Prepare workspace app factory modification request failed."
      ).job;
    },
    async publishWorkspaceAppFactoryJob(workspaceID, jobID) {
      const response = await publishWorkspaceAppFactoryJob({
        client,
        path: { jobID, workspaceID }
      });
      return unwrapData(
        response,
        "Publish workspace app factory job request failed."
      );
    }
  };
}
