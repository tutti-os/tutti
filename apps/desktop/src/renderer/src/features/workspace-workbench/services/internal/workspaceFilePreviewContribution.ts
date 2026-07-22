import { createElement } from "react";
import type {
  WorkbenchContribution,
  WorkbenchHostNodeDefinition
} from "@tutti-os/workbench-surface";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import { workspaceWorkbenchDesktopI18nKeys } from "@shared/i18n";
import { FilePreviewClosedReporter } from "../../../analytics/reporters/file-preview-closed/filePreviewClosedReporter.ts";
import { FilePreviewOpenedReporter } from "../../../analytics/reporters/file-preview-opened/filePreviewOpenedReporter.ts";
import { createAnalyticsOpenedSourceParams } from "../../../analytics/reporters/openedSource.ts";
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import type { DesktopHostFilesApi } from "@preload/types";
import { createWorkspaceFilePreviewWindowSaveRequestSource } from "../workspaceFilePreviewSaveRequests.ts";
import { WorkspaceFilePreviewNodeBody } from "../../ui/WorkspaceFilePreviewNodeBody.tsx";
import { WorkspaceFilePreviewNodeHeader } from "../../ui/WorkspaceFilePreviewNodeHeader.tsx";
import {
  createWorkspaceFilePreviewInstanceID,
  coerceWorkspaceFilePreviewTarget,
  isWorkspaceFilePreviewNodeTypeID,
  resolveWorkspaceFilePreviewNodeTypeID,
  workspaceFilePreviewActivationType,
  workspaceImageFileNodeTypeID,
  workspaceTextFileNodeTypeID
} from "../workspaceFilePreviewLaunch.ts";
import {
  composeWorkbenchNodeLeases,
  createTrackedWorkbenchNodeLease
} from "./workspaceNodeLifecycleAnalytics.ts";
import { workspaceFilePreviewNodeFrame } from "./workspaceWorkbenchComposition.ts";

export function createWorkspaceFilePreviewContribution(input: {
  appI18n: I18nRuntime<string>;
  hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  tuttidClient: Pick<
    TuttidClient,
    "readWorkspaceFilePreview" | "writeWorkspaceFileText"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  workspaceId: string;
}): WorkbenchContribution {
  return {
    id: "workspace-file-preview",
    nodes: [
      createWorkspaceFilePreviewNodeDefinition({
        ...input,
        title: input.i18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.textFile),
        typeId: workspaceTextFileNodeTypeID
      }),
      createWorkspaceFilePreviewNodeDefinition({
        ...input,
        title: input.i18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.imageFile),
        typeId: workspaceImageFileNodeTypeID
      })
    ],
    onLaunchRequest: (request) => {
      const target = coerceWorkspaceFilePreviewTarget(request.payload);
      if (!isWorkspaceFilePreviewNodeTypeID(request.typeId) || !target) {
        return null;
      }

      if (
        request.typeId !==
        resolveWorkspaceFilePreviewNodeTypeID(target.previewKind)
      ) {
        return null;
      }

      return {
        activation: {
          payload: target,
          type: workspaceFilePreviewActivationType
        },
        defaultFrame: workspaceFilePreviewNodeFrame,
        framePolicy: "cascade-same-type-centered",
        instanceId: createWorkspaceFilePreviewInstanceID(target),
        title: target.name,
        typeId: request.typeId
      };
    }
  };
}

function createWorkspaceFilePreviewNodeDefinition(input: {
  appI18n: I18nRuntime<string>;
  hostFilesApi: Pick<DesktopHostFilesApi, "readLocalPreviewFile">;
  i18n: WorkspaceWorkbenchDesktopI18nRuntime;
  tuttidClient: Pick<
    TuttidClient,
    "readWorkspaceFilePreview" | "writeWorkspaceFileText"
  >;
  reporterService?: Pick<IReporterService, "trackEvents">;
  title: string;
  typeId: string;
  workspaceId: string;
}): WorkbenchHostNodeDefinition {
  const saveRequestSource = createWorkspaceFilePreviewWindowSaveRequestSource(
    globalThis.window
  );

  return {
    frame: workspaceFilePreviewNodeFrame,
    createLease: (context) =>
      composeWorkbenchNodeLeases(
        createTrackedWorkbenchNodeLease({
          closedParams: ({ durationMs }) => ({ durationMs }),
          closedReporter: FilePreviewClosedReporter,
          openedParams: {
            ...createAnalyticsOpenedSourceParams(
              context.node.data.activation ? "file_manager" : "restore"
            ),
            fileExtension: resolvePreviewFileExtension(
              context.node.data.activation?.payload
            )
          },
          openedReporter: FilePreviewOpenedReporter,
          reporterService: input.reporterService
        })
      ),
    instance: {
      mode: "multi"
    },
    renderBody: (context) =>
      createElement(WorkspaceFilePreviewNodeBody, {
        appI18n: input.appI18n,
        context,
        hostFilesApi: input.hostFilesApi,
        i18n: input.i18n,
        tuttidClient: input.tuttidClient,
        saveRequestSource,
        workspaceID: input.workspaceId
      }),
    renderHeader: (context) =>
      createElement(WorkspaceFilePreviewNodeHeader, {
        context,
        i18n: input.i18n
      }),
    title: input.title,
    typeId: input.typeId,
    window: {
      closable: true,
      defaultOpen: false,
      minimizedDock: {
        kind: "snapshot"
      },
      minimizable: true,
      surfaceLayer: "dialog-popover"
    }
  };
}

function resolvePreviewFileExtension(payload: unknown): string | null {
  const target = coerceWorkspaceFilePreviewTarget(payload);
  if (!target) {
    return null;
  }

  const source = target.name || target.path;
  const slashIndex = Math.max(
    source.lastIndexOf("/"),
    source.lastIndexOf("\\")
  );
  const fileName = source.slice(slashIndex + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return null;
  }
  return fileName.slice(dotIndex + 1).toLowerCase();
}
