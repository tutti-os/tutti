import type {
  DesktopPreferencesStateResponse,
  TuttidEventStreamClient,
  TuttidClient,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";

export interface DesktopPreferencesClient {
  connect(): Promise<void>;
  dispose(): void;
  getDesktopPreferences(): Promise<DesktopPreferencesStateResponse>;
  updateDesktopPreferences(
    request: PutDesktopPreferencesRequest
  ): Promise<PutDesktopPreferencesRequest["preferences"]>;
  subscribeToDesktopPreferencesUpdated(
    listener: (preferences: PutDesktopPreferencesRequest["preferences"]) => void
  ): () => void;
}

export interface CreateDesktopPreferencesClientOptions {
  authoritativeEventTimeoutMs?: number;
}

interface PendingDesktopPreferencesUpdate {
  key: string;
  preferences: PutDesktopPreferencesRequest["preferences"];
  promise: Promise<PutDesktopPreferencesRequest["preferences"]>;
  reject: (error: Error) => void;
  resolve: (preferences: PutDesktopPreferencesRequest["preferences"]) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export function createDesktopPreferencesClient(
  tuttidClient: Pick<TuttidClient, "getDesktopPreferences">,
  eventStreamClient: TuttidEventStreamClient,
  options: CreateDesktopPreferencesClientOptions = {}
): DesktopPreferencesClient {
  const authoritativeEventTimeoutMs =
    options.authoritativeEventTimeoutMs ?? 1_000;
  const listeners = new Set<
    (preferences: PutDesktopPreferencesRequest["preferences"]) => void
  >();
  const pendingUpdates = new Map<string, PendingDesktopPreferencesUpdate>();
  const unsubscribeEventStream = eventStreamClient.subscribe(
    "preferences.desktop.updated",
    (event) => {
      applyAuthoritativePreferences(event.payload.preferences);
    }
  );

  return {
    connect() {
      return eventStreamClient.connect();
    },
    dispose() {
      unsubscribeEventStream();
      const disposeError = new Error(
        "Desktop preferences client was disposed."
      );
      for (const pendingUpdate of pendingUpdates.values()) {
        rejectPendingUpdate(pendingUpdate, disposeError);
      }
      pendingUpdates.clear();
    },
    getDesktopPreferences() {
      return tuttidClient.getDesktopPreferences();
    },
    async updateDesktopPreferences(request) {
      const key = createPreferencesKey(request.preferences);
      const existingPendingUpdate = pendingUpdates.get(key);
      if (existingPendingUpdate) {
        return await existingPendingUpdate.promise;
      }

      const pendingUpdate = createPendingUpdate(key, request.preferences);
      pendingUpdates.set(key, pendingUpdate);

      try {
        await eventStreamClient.publishIntent(
          "preferences.desktop.update.requested",
          {
            preferences: request.preferences
          }
        );
      } catch (error) {
        if (pendingUpdates.get(key) === pendingUpdate) {
          rejectPendingUpdate(
            pendingUpdate,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }

      if (pendingUpdates.get(key) === pendingUpdate) {
        scheduleAuthoritativeConfirmation(pendingUpdate);
      }

      return await pendingUpdate.promise;
    },
    subscribeToDesktopPreferencesUpdated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };

  function createPendingUpdate(
    key: string,
    preferences: PutDesktopPreferencesRequest["preferences"]
  ): PendingDesktopPreferencesUpdate {
    let rejectFn: (error: Error) => void = () => {};
    let resolveFn: (
      authoritativePreferences: PutDesktopPreferencesRequest["preferences"]
    ) => void = () => {};
    const promise = new Promise<PutDesktopPreferencesRequest["preferences"]>(
      (resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      }
    );

    return {
      key,
      preferences,
      promise,
      reject: rejectFn,
      resolve: resolveFn,
      timeoutHandle: null
    };
  }

  function scheduleAuthoritativeConfirmation(
    pendingUpdate: PendingDesktopPreferencesUpdate
  ): void {
    pendingUpdate.timeoutHandle = setTimeout(() => {
      void confirmPendingUpdateFromServer(pendingUpdate);
    }, authoritativeEventTimeoutMs);
  }

  async function confirmPendingUpdateFromServer(
    pendingUpdate: PendingDesktopPreferencesUpdate
  ): Promise<void> {
    if (pendingUpdates.get(pendingUpdate.key) !== pendingUpdate) {
      return;
    }

    try {
      const currentState = await tuttidClient.getDesktopPreferences();
      if (
        currentState.initialized &&
        preferencesEqual(currentState.preferences, pendingUpdate.preferences)
      ) {
        applyAuthoritativePreferences(currentState.preferences);
        return;
      }
    } catch (error) {
      rejectPendingUpdate(
        pendingUpdate,
        new Error(
          error instanceof Error
            ? `Desktop preferences update could not be confirmed: ${error.message}`
            : "Desktop preferences update could not be confirmed."
        )
      );
      return;
    }

    rejectPendingUpdate(
      pendingUpdate,
      new Error(
        "Desktop preferences update was acknowledged, but the authoritative update did not arrive."
      )
    );
  }

  function applyAuthoritativePreferences(
    preferences: PutDesktopPreferencesRequest["preferences"]
  ): void {
    for (const listener of listeners) {
      listener(preferences);
    }

    const pendingUpdate = pendingUpdates.get(createPreferencesKey(preferences));
    if (pendingUpdate) {
      resolvePendingUpdate(pendingUpdate, preferences);
    }
  }

  function resolvePendingUpdate(
    pendingUpdate: PendingDesktopPreferencesUpdate,
    preferences: PutDesktopPreferencesRequest["preferences"]
  ): void {
    clearPendingUpdateTimeout(pendingUpdate);
    pendingUpdates.delete(pendingUpdate.key);
    pendingUpdate.resolve(preferences);
  }

  function rejectPendingUpdate(
    pendingUpdate: PendingDesktopPreferencesUpdate,
    error: Error
  ): void {
    clearPendingUpdateTimeout(pendingUpdate);
    pendingUpdates.delete(pendingUpdate.key);
    pendingUpdate.reject(error);
  }

  function clearPendingUpdateTimeout(
    pendingUpdate: PendingDesktopPreferencesUpdate
  ): void {
    if (pendingUpdate.timeoutHandle !== null) {
      clearTimeout(pendingUpdate.timeoutHandle);
      pendingUpdate.timeoutHandle = null;
    }
  }
}

function createPreferencesKey(
  preferences: PutDesktopPreferencesRequest["preferences"]
): string {
  return [
    stableAgentComposerDefaultsKey(preferences.agentComposerDefaultsByProvider),
    preferences.browserUseConnectionMode ?? "isolated",
    preferences.defaultAgentProvider,
    preferences.dockIconStyle,
    preferences.dockPlacement,
    preferences.locale,
    preferences.sleepPreventionMode,
    preferences.themeSource
  ].join("::");
}

function preferencesEqual(
  left: PutDesktopPreferencesRequest["preferences"],
  right: PutDesktopPreferencesRequest["preferences"]
): boolean {
  return (
    stableAgentComposerDefaultsKey(left.agentComposerDefaultsByProvider) ===
      stableAgentComposerDefaultsKey(right.agentComposerDefaultsByProvider) &&
    (left.browserUseConnectionMode ?? "isolated") ===
      (right.browserUseConnectionMode ?? "isolated") &&
    left.defaultAgentProvider === right.defaultAgentProvider &&
    left.dockIconStyle === right.dockIconStyle &&
    left.dockPlacement === right.dockPlacement &&
    left.locale === right.locale &&
    left.sleepPreventionMode === right.sleepPreventionMode &&
    left.themeSource === right.themeSource
  );
}

function stableAgentComposerDefaultsKey(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "{}";
  }
  const input = value as Record<string, unknown>;
  const providers = [
    "claude-code",
    "codex",
    "nexight",
    "gemini",
    "hermes",
    "openclaw"
  ];
  const output: Record<string, Record<string, string>> = {};
  for (const provider of providers) {
    const defaults = input[provider];
    if (!defaults || typeof defaults !== "object") {
      continue;
    }
    const fields = defaults as Record<string, unknown>;
    const normalizedDefaults: Record<string, string> = {};
    for (const key of ["model", "permissionModeId", "reasoningEffort"]) {
      const normalized = normalizeOptionalText(fields[key]);
      if (normalized) {
        normalizedDefaults[key] = normalized;
      }
    }
    if (Object.keys(normalizedDefaults).length > 0) {
      output[provider] = normalizedDefaults;
    }
  }
  return JSON.stringify(output);
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}
