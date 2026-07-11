import {
  tuttiExternalOperations,
  type TuttiExternalOperation
} from "../contracts/index.ts";

export { tuttiExternalOperations };

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
