import type {
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalBrowserOpenUrlInput,
  TuttiExternalCapabilities,
  TuttiExternalFileOpenInput,
  TuttiExternalFileSelectInput,
  TuttiExternalFileSelectResult,
  TuttiExternalFileUploadInput,
  TuttiExternalLogInput,
  TuttiExternalOperation,
  TuttiExternalPdfPrintHtmlInput,
  TuttiExternalPdfPrintHtmlResult,
  TuttiExternalPermissionRequestInput,
  TuttiExternalPermissionRequestResult,
  TuttiExternalReferenceOpenInput,
  TuttiExternalSettingsOpenInput,
  TuttiExternalUploadedFile,
  TuttiExternalUserProjectCreateInput,
  TuttiExternalUserProjectPathInput,
  TuttiExternalUserProjectRememberDefaultSelectionInput,
  TuttiExternalWorkspaceOpenFeatureInput,
  TuttiExternalWorkspaceOpenRouteIntent
} from "../contracts/index.ts";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectServiceSnapshot
} from "@tutti-os/workspace-user-project/contracts";

export interface TuttiExternalRequestInputMap {
  "app.getContext": undefined;
  "activity.reportActive": undefined;
  "at.query": TuttiExternalAtQueryInput;
  "files.select": TuttiExternalFileSelectInput;
  "files.open": TuttiExternalFileOpenInput;
  "permissions.request": TuttiExternalPermissionRequestInput;
  "settings.open": TuttiExternalSettingsOpenInput;
  "workspace.openFeature": TuttiExternalWorkspaceOpenFeatureInput;
  "references.open": TuttiExternalReferenceOpenInput;
  "pdf.printHtmlToPdf": TuttiExternalPdfPrintHtmlInput;
  "userProjects.checkPath": TuttiExternalUserProjectPathInput;
  "userProjects.create": TuttiExternalUserProjectCreateInput;
  "userProjects.getDefaultSelection": undefined;
  "userProjects.getSnapshot": undefined;
  "userProjects.list": undefined;
  "userProjects.prepareSelection": WorkspaceUserProjectSelectionPreparationInput;
  "userProjects.refresh": undefined;
  "userProjects.rememberDefaultSelection": TuttiExternalUserProjectRememberDefaultSelectionInput;
  "userProjects.selectDirectory": undefined;
  "userProjects.use": TuttiExternalUserProjectPathInput;
}

export interface TuttiExternalRequestResultMap {
  "app.getContext": unknown;
  "activity.reportActive": void;
  "at.query": TuttiExternalAtQueryResult[];
  "files.select": TuttiExternalFileSelectResult;
  "files.open": void;
  "permissions.request": TuttiExternalPermissionRequestResult;
  "settings.open": void;
  "workspace.openFeature": void;
  "references.open": void;
  "pdf.printHtmlToPdf": TuttiExternalPdfPrintHtmlResult;
  "userProjects.checkPath": WorkspaceUserProjectPathCheck;
  "userProjects.create": WorkspaceUserProject;
  "userProjects.getDefaultSelection": WorkspaceUserProjectDefaultSelection | null;
  "userProjects.getSnapshot": WorkspaceUserProjectServiceSnapshot;
  "userProjects.list": { projects: WorkspaceUserProject[] };
  "userProjects.prepareSelection": WorkspaceUserProjectSelectionPreparation;
  "userProjects.refresh": WorkspaceUserProjectServiceSnapshot;
  "userProjects.rememberDefaultSelection": void;
  "userProjects.selectDirectory": { path: string } | null;
  "userProjects.use": WorkspaceUserProject;
}

export type TuttiExternalRequestOperation = keyof TuttiExternalRequestInputMap;

export interface TuttiExternalNotificationInputMap {
  "browser.openUrl": TuttiExternalBrowserOpenUrlInput;
  "logs.write": TuttiExternalLogInput;
}

export type TuttiExternalNotifyOperation =
  keyof TuttiExternalNotificationInputMap;

export interface TuttiExternalHostEventPayloadMap {
  "app.contextChanged": unknown;
  "workspace.launchIntent": TuttiExternalWorkspaceOpenRouteIntent;
  "userProjects.changed": WorkspaceUserProjectServiceSnapshot;
}

export type TuttiExternalHostEvent = keyof TuttiExternalHostEventPayloadMap;

export interface TuttiExternalHostEventStream<TPayload> {
  initial: Promise<TPayload | undefined>;
  unsubscribe(): void;
}

export interface TuttiExternalHostAdapter {
  readonly capabilities: TuttiExternalCapabilities;

  request<TOperation extends TuttiExternalRequestOperation>(
    operation: TOperation,
    input: TuttiExternalRequestInputMap[TOperation]
  ): Promise<TuttiExternalRequestResultMap[TOperation]>;

  notify<TOperation extends TuttiExternalNotifyOperation>(
    operation: TOperation,
    input: TuttiExternalNotificationInputMap[TOperation]
  ): void;

  openEventStream<TEvent extends TuttiExternalHostEvent>(
    event: TEvent,
    listener: (payload: TuttiExternalHostEventPayloadMap[TEvent]) => void
  ): TuttiExternalHostEventStream<TuttiExternalHostEventPayloadMap[TEvent]>;

  upload(
    file: Blob | File,
    input: TuttiExternalFileUploadInput & { purpose: "app-asset" }
  ): Promise<TuttiExternalUploadedFile>;
}

export interface CreateTuttiExternalBridgeOptions {
  adapter: TuttiExternalHostAdapter;
  isUserActivationActive(): boolean;
}

export type TuttiExternalSubscriptionOperation = Extract<
  TuttiExternalOperation,
  "app.subscribe" | "workspace.onLaunchIntent" | "userProjects.subscribe"
>;

type TuttiExternalRoutedOperation =
  | TuttiExternalRequestOperation
  | TuttiExternalNotifyOperation
  | TuttiExternalSubscriptionOperation
  | "files.upload";

type AssertNoOperation<T extends never> = T;

export type TuttiExternalUnroutedOperation = AssertNoOperation<
  Exclude<TuttiExternalOperation, TuttiExternalRoutedOperation>
>;

export type TuttiExternalUnknownRoutedOperation = AssertNoOperation<
  Exclude<TuttiExternalRoutedOperation, TuttiExternalOperation>
>;
