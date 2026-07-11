import type {
  TuttiExternalAtQueryInput,
  TuttiExternalBridge,
  TuttiExternalCapabilities,
  TuttiExternalOperation,
  TuttiExternalPermissionRequestInput,
  TuttiExternalWorkspaceOpenFeatureInput
} from "../contracts/index.ts";
import {
  createTuttiExternalOperationError,
  isTuttiExternalOperationError,
  normalizeTuttiExternalAtQueryInput,
  normalizeTuttiExternalBrowserOpenUrlInput,
  normalizeTuttiExternalFileOpenInput,
  normalizeTuttiExternalFileSelectInput,
  normalizeTuttiExternalLogInput,
  normalizeTuttiExternalPdfPrintHtmlInput,
  normalizeTuttiExternalPermissionRequestInput,
  normalizeTuttiExternalReferenceOpenInput,
  normalizeTuttiExternalSettingsOpenInput,
  normalizeTuttiExternalUserProjectCreateInput,
  normalizeTuttiExternalUserProjectPathInput,
  normalizeTuttiExternalUserProjectRememberDefaultSelectionInput,
  normalizeTuttiExternalUserProjectSelectionPreparationInput,
  normalizeTuttiExternalWorkspaceOpenFeatureInput
} from "../core/index.ts";
import {
  normalizeTuttiExternalCapabilities,
  supportsTuttiExternalOperation
} from "./capabilities.ts";
import { createHostEventStore } from "./event-store.ts";
import { tuttiExternalUserActivationOperations } from "./operation-map.ts";
import {
  normalizeTuttiExternalHostEventPayload,
  normalizeTuttiExternalRequestResult
} from "./results.ts";
import type {
  CreateTuttiExternalBridgeOptions,
  TuttiExternalHostAdapter,
  TuttiExternalHostEventPayloadMap,
  TuttiExternalRequestInputMap,
  TuttiExternalRequestOperation,
  TuttiExternalRequestResultMap
} from "./types.ts";
import { uploadTuttiExternalFile } from "./upload.ts";

export function createTuttiExternalBridge(
  options: CreateTuttiExternalBridgeOptions
): TuttiExternalBridge {
  const { adapter } = options;
  const capabilities = normalizeTuttiExternalCapabilities(adapter.capabilities);
  const contextStore = createEventStore(
    adapter,
    "app.contextChanged",
    true,
    false
  );
  const launchIntentStore = createEventStore(
    adapter,
    "workspace.launchIntent",
    false,
    true
  );
  const userProjectStore = createEventStore(
    adapter,
    "userProjects.changed",
    true,
    false
  );

  async function request<TOperation extends TuttiExternalRequestOperation>(
    operation: TOperation,
    input: TuttiExternalRequestInputMap[TOperation]
  ): Promise<TuttiExternalRequestResultMap[TOperation]> {
    try {
      ensureSupported(capabilities, operation);
      ensureUserActivation(options, operation);
      const result = await adapter.request(operation, input);
      return normalizeTuttiExternalRequestResult(operation, result);
    } catch (error) {
      throw mapOperationError(operation, error);
    }
  }

  async function normalizeAndRequest<
    TOperation extends TuttiExternalRequestOperation
  >(
    operation: TOperation,
    normalize: () => TuttiExternalRequestInputMap[TOperation]
  ): Promise<TuttiExternalRequestResultMap[TOperation]> {
    let input: TuttiExternalRequestInputMap[TOperation];
    try {
      input = normalize();
    } catch (error) {
      if (isTuttiExternalOperationError(error)) {
        throw error;
      }
      throw createTuttiExternalOperationError({
        cause: error,
        code: "invalid_input",
        operation,
        message:
          error instanceof Error
            ? error.message
            : `tuttiExternal.${operation} input is invalid.`
      });
    }
    return request(operation, input);
  }

  async function notifyBrowser(input: unknown): Promise<void> {
    const operation = "browser.openUrl";
    try {
      ensureSupported(capabilities, operation);
      ensureUserActivation(options, operation);
      adapter.notify(
        operation,
        normalizeTuttiExternalBrowserOpenUrlInput(input)
      );
    } catch (error) {
      throw mapOperationError(operation, error);
    }
  }

  return {
    capabilities,
    app: {
      getContext: () => request("app.getContext", undefined),
      subscribe(listener) {
        ensureSubscriptionSupported(capabilities, "app.subscribe");
        return contextStore.subscribe(listener);
      }
    },
    activity: {
      reportActive: () => request("activity.reportActive", undefined)
    },
    browser: {
      openUrl: notifyBrowser
    },
    at: {
      query: (input) =>
        normalizeAndRequest("at.query", () => {
          const normalized = normalizeTuttiExternalAtQueryInput(input);
          assertAtProvidersSupported(capabilities, normalized);
          return normalized;
        })
    },
    files: {
      select: (input) =>
        normalizeAndRequest("files.select", () =>
          normalizeTuttiExternalFileSelectInput(input)
        ),
      open: (input) =>
        normalizeAndRequest("files.open", () =>
          normalizeTuttiExternalFileOpenInput(input)
        ),
      async upload(file, input) {
        const operation = "files.upload";
        try {
          ensureSupported(capabilities, operation);
          return await uploadTuttiExternalFile(adapter, file, input);
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          throw mapOperationError(operation, error);
        }
      }
    },
    permissions: {
      request: (input) =>
        normalizeAndRequest("permissions.request", () => {
          const normalized =
            normalizeTuttiExternalPermissionRequestInput(input);
          assertManagedAiProvidersSupported(capabilities, normalized);
          return normalized;
        })
    },
    settings: {
      open: (input) =>
        normalizeAndRequest("settings.open", () =>
          normalizeTuttiExternalSettingsOpenInput(input)
        )
    },
    workspace: {
      onLaunchIntent(listener) {
        ensureSubscriptionSupported(capabilities, "workspace.onLaunchIntent");
        return launchIntentStore.subscribe(listener);
      },
      openFeature: (input) =>
        normalizeAndRequest("workspace.openFeature", () => {
          const normalized =
            normalizeTuttiExternalWorkspaceOpenFeatureInput(input);
          assertWorkspaceFeatureSupported(capabilities, normalized);
          return normalized;
        })
    },
    references: {
      open: (input) =>
        normalizeAndRequest("references.open", () =>
          normalizeTuttiExternalReferenceOpenInput(input)
        )
    },
    pdf: {
      printHtmlToPdf: (input) =>
        normalizeAndRequest("pdf.printHtmlToPdf", () =>
          normalizeTuttiExternalPdfPrintHtmlInput(input)
        )
    },
    userProjects: {
      checkPath: (input) =>
        normalizeAndRequest("userProjects.checkPath", () =>
          normalizeTuttiExternalUserProjectPathInput(input, "checkPath")
        ),
      create: (input) =>
        normalizeAndRequest("userProjects.create", () =>
          normalizeTuttiExternalUserProjectCreateInput(input)
        ),
      getDefaultSelection: () =>
        request("userProjects.getDefaultSelection", undefined),
      getSnapshot: () => request("userProjects.getSnapshot", undefined),
      list: () => request("userProjects.list", undefined),
      prepareSelection: (input) =>
        normalizeAndRequest("userProjects.prepareSelection", () =>
          normalizeTuttiExternalUserProjectSelectionPreparationInput(input)
        ),
      refresh: () => request("userProjects.refresh", undefined),
      rememberDefaultSelection: (input) =>
        normalizeAndRequest("userProjects.rememberDefaultSelection", () =>
          normalizeTuttiExternalUserProjectRememberDefaultSelectionInput(input)
        ),
      selectDirectory: () => request("userProjects.selectDirectory", undefined),
      subscribe(listener) {
        ensureSubscriptionSupported(capabilities, "userProjects.subscribe");
        return userProjectStore.subscribe(listener);
      },
      use: (input) =>
        normalizeAndRequest("userProjects.use", () =>
          normalizeTuttiExternalUserProjectPathInput(input, "use")
        )
    },
    logs: {
      write(input) {
        try {
          if (!supportsTuttiExternalOperation(capabilities, "logs.write")) {
            return;
          }
          adapter.notify("logs.write", normalizeTuttiExternalLogInput(input));
        } catch {
          // Diagnostics must never break an app flow.
        }
      }
    }
  };
}

function createEventStore<
  TEvent extends keyof TuttiExternalHostEventPayloadMap
>(
  adapter: TuttiExternalHostAdapter,
  event: TEvent,
  replayLatest: boolean,
  consumeInitialOnce: boolean
) {
  return createHostEventStore<TuttiExternalHostEventPayloadMap[TEvent]>({
    consumeInitialOnce,
    open(listener) {
      const stream = adapter.openEventStream(event, (payload) => {
        try {
          listener(normalizeTuttiExternalHostEventPayload(event, payload));
        } catch {
          // Invalid host events are ignored at the trust boundary.
        }
      });
      return {
        initial: stream.initial.then((payload) =>
          payload === undefined
            ? undefined
            : normalizeTuttiExternalHostEventPayload(event, payload)
        ),
        unsubscribe: stream.unsubscribe
      };
    },
    replayLatest
  });
}

function ensureSupported(
  capabilities: TuttiExternalCapabilities,
  operation: TuttiExternalOperation
): void {
  if (!supportsTuttiExternalOperation(capabilities, operation)) {
    throw createTuttiExternalOperationError({
      code: "unsupported_operation",
      operation,
      message: `tuttiExternal.${operation} is not supported by this host.`
    });
  }
}

function ensureSubscriptionSupported(
  capabilities: TuttiExternalCapabilities,
  operation:
    | "app.subscribe"
    | "workspace.onLaunchIntent"
    | "userProjects.subscribe"
): void {
  ensureSupported(capabilities, operation);
}

function ensureUserActivation(
  options: CreateTuttiExternalBridgeOptions,
  operation: TuttiExternalOperation
): void {
  if (
    tuttiExternalUserActivationOperations.includes(
      operation as (typeof tuttiExternalUserActivationOperations)[number]
    ) &&
    !options.isUserActivationActive()
  ) {
    throw createTuttiExternalOperationError({
      code: "user_activation_required",
      operation,
      message: `tuttiExternal.${operation} requires user activation.`
    });
  }
}

function mapOperationError(
  operation: TuttiExternalOperation,
  error: unknown
): Error {
  if (isTuttiExternalOperationError(error)) {
    return error;
  }
  const hostCode = readHostErrorCode(error);
  return createTuttiExternalOperationError({
    cause: error,
    code: mapHostErrorCode(hostCode),
    ...(hostCode ? { hostCode } : {}),
    operation,
    message: `tuttiExternal.${operation} failed.`
  });
}

function readHostErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function mapHostErrorCode(hostCode: string | undefined) {
  if (hostCode?.includes("invalid_input")) {
    return "invalid_input" as const;
  }
  if (hostCode?.includes("unauthorized")) {
    return "unauthorized" as const;
  }
  if (hostCode?.includes("unavailable")) {
    return "unavailable" as const;
  }
  return "operation_failed" as const;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function assertAtProvidersSupported(
  capabilities: TuttiExternalCapabilities,
  input: TuttiExternalAtQueryInput
): void {
  if (!input.providers || !capabilities.atProviders) {
    return;
  }
  if (
    input.providers.some(
      (provider) => !capabilities.atProviders?.includes(provider)
    )
  ) {
    throw createUnsupportedValueError("at.query", "provider");
  }
}

function assertManagedAiProvidersSupported(
  capabilities: TuttiExternalCapabilities,
  input: TuttiExternalPermissionRequestInput
): void {
  if (!input.providers || !capabilities.managedAiProviders) {
    return;
  }
  if (
    input.providers.some(
      (provider) => !capabilities.managedAiProviders?.includes(provider)
    )
  ) {
    throw createUnsupportedValueError("permissions.request", "provider");
  }
}

function assertWorkspaceFeatureSupported(
  capabilities: TuttiExternalCapabilities,
  input: TuttiExternalWorkspaceOpenFeatureInput
): void {
  if (
    capabilities.workspaceFeatures &&
    !capabilities.workspaceFeatures.includes(input.feature)
  ) {
    throw createUnsupportedValueError("workspace.openFeature", "feature");
  }
  if (
    input.provider &&
    capabilities.workspaceAgentProviders &&
    !capabilities.workspaceAgentProviders.includes(input.provider)
  ) {
    throw createUnsupportedValueError("workspace.openFeature", "provider");
  }
}

function createUnsupportedValueError(
  operation: TuttiExternalOperation,
  value: string
): Error {
  return createTuttiExternalOperationError({
    code: "unsupported_operation",
    operation,
    message: `tuttiExternal.${operation} ${value} is not supported by this host.`
  });
}
