import type {
  ExportDeveloperLogsInput,
  ExportDeveloperLogsResult
} from "../shared/contracts/ipc.ts";
import {
  createTranslator,
  type DesktopLocale,
  type Translator
} from "../shared/i18n/index.ts";
import type { DeveloperLogsService } from "./developerLogs.ts";

export interface DeveloperLogsExportSuccessDialogOptions {
  type: "info";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export interface DeveloperLogsExportDialogResult {
  response: number;
}

export interface DeveloperLogsExportDialogActions {
  showItemInFolder(path: string): void;
  writeClipboardText(text: string): void;
}

type DeveloperLogsExporter = Pick<DeveloperLogsService, "exportLogs">;

export interface DeveloperLogsExportNotifyDependencies {
  exportInput: ExportDeveloperLogsInput;
  locale?: DesktopLocale;
  service: DeveloperLogsExporter;
  showMessageBox?: (
    options: DeveloperLogsExportSuccessDialogOptions
  ) => Promise<DeveloperLogsExportDialogResult>;
  showItemInFolder?: (path: string) => void;
  writeClipboardText?: (text: string) => void;
}

function resolveParentDirectory(filePath: string): string {
  const normalizedPath = filePath.trim();
  const separatorIndex = Math.max(
    normalizedPath.lastIndexOf("/"),
    normalizedPath.lastIndexOf("\\")
  );

  if (separatorIndex < 0) {
    return ".";
  }

  if (separatorIndex === 0) {
    return normalizedPath[0] ?? "/";
  }

  const parentDirectory = normalizedPath.slice(0, separatorIndex);
  if (/^[A-Za-z]:$/.test(parentDirectory)) {
    return `${parentDirectory}${normalizedPath[separatorIndex]}`;
  }

  return parentDirectory;
}

export function buildDeveloperLogsAgentPrompt({
  filePath,
  translator = createTranslator("en")
}: {
  filePath: string;
  translator?: Translator;
}): string {
  const downloadDirectory = resolveParentDirectory(filePath);

  return [
    translator.t("desktop.logsExport.agentPrompt.intro"),
    "",
    translator.t("desktop.logsExport.agentPrompt.archivePath", { filePath }),
    translator.t("desktop.logsExport.agentPrompt.downloadDirectory", {
      downloadDirectory
    }),
    "",
    translator.t("desktop.logsExport.agentPrompt.stepsHeader"),
    translator.t("desktop.logsExport.agentPrompt.stepInspect"),
    translator.t("desktop.logsExport.agentPrompt.stepEvidence"),
    translator.t("desktop.logsExport.agentPrompt.stepFixPlan"),
    translator.t("desktop.logsExport.agentPrompt.stepImplement")
  ].join("\n");
}

export function createDeveloperLogsExportSuccessDialogOptions(
  result: ExportDeveloperLogsResult,
  translator: Translator = createTranslator("en")
): DeveloperLogsExportSuccessDialogOptions {
  return {
    type: "info",
    title: translator.t("desktop.logsExport.title"),
    message: translator.t("desktop.logsExport.savedTitle"),
    detail: [
      translator.t("desktop.logsExport.savedTo", {
        count: String(result.fileCount)
      }),
      result.filePath ?? "",
      "",
      translator.t("desktop.logsExport.actionHint")
    ].join("\n"),
    buttons: [
      translator.t("desktop.logsExport.copyAgentPrompt"),
      translator.t("desktop.logsExport.openFolder"),
      translator.t("desktop.logsExport.ok")
    ],
    defaultId: 2,
    cancelId: 2,
    noLink: true
  };
}

export function handleDeveloperLogsExportSuccessDialogResponse(
  dialogResult: DeveloperLogsExportDialogResult,
  exportResult: ExportDeveloperLogsResult,
  actions: DeveloperLogsExportDialogActions,
  translator: Translator = createTranslator("en")
): void {
  if (!exportResult.filePath) {
    return;
  }

  if (dialogResult.response === 0) {
    actions.writeClipboardText(
      buildDeveloperLogsAgentPrompt({
        filePath: exportResult.filePath,
        translator
      })
    );
    return;
  }

  if (dialogResult.response === 1) {
    actions.showItemInFolder(exportResult.filePath);
  }
}

export async function exportDeveloperLogsToDefaultDownloadsPathAndNotify(
  deps: DeveloperLogsExportNotifyDependencies
): Promise<ExportDeveloperLogsResult> {
  const result = await deps.service.exportLogs({
    includeAgentSessions: deps.exportInput.includeAgentSessions,
    scope: deps.exportInput.scope
  });

  if (result.canceled || !result.filePath) {
    return result;
  }

  const dialogResult = await (deps.showMessageBox ?? defaultShowMessageBox)(
    createDeveloperLogsExportSuccessDialogOptions(
      result,
      createTranslator(deps.locale ?? "en")
    )
  );
  handleDeveloperLogsExportSuccessDialogResponse(
    dialogResult,
    result,
    {
      showItemInFolder: deps.showItemInFolder ?? defaultShowItemInFolder,
      writeClipboardText: deps.writeClipboardText ?? defaultWriteClipboardText
    },
    createTranslator(deps.locale ?? "en")
  );

  return result;
}

async function defaultShowMessageBox(
  options: DeveloperLogsExportSuccessDialogOptions
): Promise<DeveloperLogsExportDialogResult> {
  const { dialog } = await import("electron");
  return dialog.showMessageBox(options);
}

function defaultShowItemInFolder(path: string): void {
  void import("electron").then(({ shell }) => {
    shell.showItemInFolder(path);
  });
}

function defaultWriteClipboardText(text: string): void {
  void import("electron").then(({ clipboard }) => {
    clipboard.writeText(text);
  });
}
