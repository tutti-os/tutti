import type { TuttiExternalOperation } from "../contracts/index.ts";

export const tuttiExternalOperations = [
  "app.getContext",
  "app.subscribe",
  "activity.reportActive",
  "browser.openUrl",
  "at.query",
  "files.select",
  "files.open",
  "files.upload",
  "permissions.request",
  "settings.open",
  "workspace.onLaunchIntent",
  "workspace.openFeature",
  "references.open",
  "pdf.printHtmlToPdf",
  "userProjects.checkPath",
  "userProjects.create",
  "userProjects.getDefaultSelection",
  "userProjects.getSnapshot",
  "userProjects.list",
  "userProjects.prepareSelection",
  "userProjects.refresh",
  "userProjects.rememberDefaultSelection",
  "userProjects.selectDirectory",
  "userProjects.subscribe",
  "userProjects.use",
  "logs.write"
] as const satisfies readonly TuttiExternalOperation[];

export const tuttiExternalUserActivationOperations = [
  "browser.openUrl",
  "files.select",
  "files.open",
  "permissions.request",
  "settings.open",
  "workspace.openFeature",
  "references.open",
  "pdf.printHtmlToPdf",
  "userProjects.create",
  "userProjects.selectDirectory"
] as const satisfies readonly TuttiExternalOperation[];
