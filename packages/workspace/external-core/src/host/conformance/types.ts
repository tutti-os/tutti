import type {
  TuttiExternalBridge,
  TuttiExternalFileUploadInput,
  TuttiExternalOperation,
  TuttiExternalUploadedFile
} from "../../contracts/index.ts";
import type {
  TuttiExternalHostEvent,
  TuttiExternalHostEventPayloadMap,
  TuttiExternalNotificationInputMap,
  TuttiExternalNotifyOperation,
  TuttiExternalRequestInputMap,
  TuttiExternalRequestOperation,
  TuttiExternalRequestResultMap
} from "../types.ts";
import type { TuttiExternalStable26ConformanceProfile } from "./profile.ts";

export interface TuttiExternalConformanceRequestObservation {
  readonly input: unknown;
  readonly operation: TuttiExternalRequestOperation;
}

export interface TuttiExternalConformanceNotificationObservation {
  readonly input: unknown;
  readonly operation: TuttiExternalNotifyOperation;
}

export interface TuttiExternalConformanceUploadObservation {
  readonly file: Blob | File;
  readonly input: TuttiExternalFileUploadInput & { purpose: "app-asset" };
}

export interface TuttiExternalConformanceObservations {
  readonly notifications: readonly TuttiExternalConformanceNotificationObservation[];
  readonly openedEvents: readonly TuttiExternalHostEvent[];
  readonly requests: readonly TuttiExternalConformanceRequestObservation[];
  readonly unsubscribedEvents: readonly TuttiExternalHostEvent[];
  readonly uploadPhases: readonly TuttiExternalConformanceUploadPhase[];
  readonly uploads: readonly TuttiExternalConformanceUploadObservation[];
}

export type TuttiExternalConformanceUploadPhase =
  | "cancel"
  | "complete"
  | "prepare"
  | "transfer"
  | "transfer-abort";

/**
 * Controls the transport behind a bridge created by a product's real host
 * factory. It is intentionally not a TuttiExternalHostAdapter.
 */
export interface TuttiExternalConformanceHostPort {
  blockUploadTransferUntilAbort(): void;
  clearNotificationError(operation: TuttiExternalNotifyOperation): void;
  clearRequestError(operation: TuttiExternalRequestOperation): void;
  clearUploadError(): void;
  emit<TEvent extends TuttiExternalHostEvent>(
    event: TEvent,
    payload: TuttiExternalHostEventPayloadMap[TEvent]
  ): void;
  getObservations(): TuttiExternalConformanceObservations;
  resetObservations(): void;
  setInitial<TEvent extends TuttiExternalHostEvent>(
    event: TEvent,
    value:
      | Promise<TuttiExternalHostEventPayloadMap[TEvent] | undefined>
      | TuttiExternalHostEventPayloadMap[TEvent]
      | undefined
  ): void;
  setNotificationError(
    operation: TuttiExternalNotifyOperation,
    error: unknown
  ): void;
  setRequestError(
    operation: TuttiExternalRequestOperation,
    error: unknown
  ): void;
  setRequestResult<TOperation extends TuttiExternalRequestOperation>(
    operation: TOperation,
    result: TuttiExternalRequestResultMap[TOperation]
  ): void;
  setRawRequestResult(
    operation: TuttiExternalRequestOperation,
    result: unknown
  ): void;
  setUploadError(error: unknown): void;
  setRawUploadResult(result: unknown): void;
  setUploadResult(result: TuttiExternalUploadedFile): void;
  setUploadProgress(
    progress: readonly {
      loadedBytes: number;
      ratio: number;
      totalBytes: number;
    }[]
  ): void;
  setUserActivationActive(active: boolean): void;
  settle(): Promise<void>;
  waitForUploadTransfer(): Promise<void>;
}

export interface TuttiExternalConformanceHost {
  readonly bridge: TuttiExternalBridge;
  dispose(): Promise<void> | void;
  readonly port: TuttiExternalConformanceHostPort;
}

export interface TuttiExternalConformanceDriver {
  createHost():
    | Promise<TuttiExternalConformanceHost>
    | TuttiExternalConformanceHost;
}

export type TuttiExternalConformanceCase = Readonly<{
  id: string;
  title: string;
  run: (host: TuttiExternalConformanceHost) => Promise<void>;
}>;

interface TuttiExternalRequestFixture<
  TOperation extends TuttiExternalRequestOperation
> {
  readonly expectedInput: TuttiExternalRequestInputMap[TOperation];
  readonly input: TOperation extends "files.select"
    ? TuttiExternalRequestInputMap[TOperation] | undefined
    : TuttiExternalRequestInputMap[TOperation];
  invoke(
    bridge: TuttiExternalBridge,
    input: TOperation extends "files.select"
      ? TuttiExternalRequestInputMap[TOperation] | undefined
      : TuttiExternalRequestInputMap[TOperation]
  ): Promise<unknown>;
  readonly kind: "request";
  readonly operation: TOperation;
  readonly result: TuttiExternalRequestResultMap[TOperation];
}

interface TuttiExternalNotificationFixture<
  TOperation extends TuttiExternalNotifyOperation
> {
  readonly expectedInput: TuttiExternalNotificationInputMap[TOperation];
  readonly input: TuttiExternalNotificationInputMap[TOperation];
  invoke(
    bridge: TuttiExternalBridge,
    input: TuttiExternalNotificationInputMap[TOperation]
  ): Promise<unknown> | void;
  readonly kind: "notification";
  readonly operation: TOperation;
}

interface TuttiExternalSubscriptionFixture<
  TOperation extends Extract<
    TuttiExternalOperation,
    "app.subscribe" | "userProjects.subscribe" | "workspace.onLaunchIntent"
  >
> {
  invoke(
    bridge: TuttiExternalBridge,
    listener: (payload: unknown) => void
  ): () => void;
  readonly event: TOperation extends "app.subscribe"
    ? "app.contextChanged"
    : TOperation extends "workspace.onLaunchIntent"
      ? "workspace.launchIntent"
      : "userProjects.changed";
  readonly initial: TuttiExternalHostEventPayloadMap[TuttiExternalConformanceEventForOperation<TOperation>];
  readonly kind: "subscription";
  readonly live: TuttiExternalHostEventPayloadMap[TuttiExternalConformanceEventForOperation<TOperation>];
  readonly operation: TOperation;
}

type TuttiExternalConformanceEventForOperation<
  TOperation extends
    | "app.subscribe"
    | "userProjects.subscribe"
    | "workspace.onLaunchIntent"
> = TOperation extends "app.subscribe"
  ? "app.contextChanged"
  : TOperation extends "workspace.onLaunchIntent"
    ? "workspace.launchIntent"
    : "userProjects.changed";

interface TuttiExternalUploadFixture {
  readonly expectedInput: TuttiExternalFileUploadInput & {
    purpose: "app-asset";
  };
  readonly file: Blob;
  readonly input: TuttiExternalFileUploadInput;
  invoke(
    bridge: TuttiExternalBridge,
    file: Blob,
    input: TuttiExternalFileUploadInput
  ): Promise<unknown>;
  readonly kind: "upload";
  readonly operation: "files.upload";
  readonly result: TuttiExternalUploadedFile;
}

export type TuttiExternalConformanceOperationFixture<
  TOperation extends TuttiExternalOperation
> = TOperation extends TuttiExternalRequestOperation
  ? TuttiExternalRequestFixture<TOperation>
  : TOperation extends TuttiExternalNotifyOperation
    ? TuttiExternalNotificationFixture<TOperation>
    : TOperation extends "files.upload"
      ? TuttiExternalUploadFixture
      : TOperation extends
            | "app.subscribe"
            | "userProjects.subscribe"
            | "workspace.onLaunchIntent"
        ? TuttiExternalSubscriptionFixture<TOperation>
        : never;

export type TuttiExternalConformanceOperationFixtures = {
  readonly [TOperation in TuttiExternalOperation]: TuttiExternalConformanceOperationFixture<TOperation>;
};

export type TuttiExternalConformanceInvalidResultOperation =
  | Exclude<TuttiExternalRequestOperation, "app.getContext">
  | "files.upload";

export type TuttiExternalConformanceInvalidResultFixtures = {
  readonly [TOperation in TuttiExternalConformanceInvalidResultOperation]: unknown;
};

export interface TuttiExternalConformanceController {
  readonly cases: readonly TuttiExternalConformanceCase[];
  readonly profile: TuttiExternalStable26ConformanceProfile;
  runCase(conformanceCase: TuttiExternalConformanceCase): Promise<void>;
  runAll(): Promise<void>;
}
