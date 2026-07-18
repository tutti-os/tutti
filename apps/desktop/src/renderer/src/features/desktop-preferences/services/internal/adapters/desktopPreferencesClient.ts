import type {
  DesktopPreferencesStateResponse,
  TuttidEventStreamClient,
  TuttidClient,
  PutDesktopPreferencesRequest
} from "@tutti-os/client-tuttid-ts";
import {
  defaultDesktopMinimizeAnimation,
  desktopFeatureFlagsEqual,
  desktopWorkbenchShortcutsEqual,
  desktopWorkbenchWindowSnappingEqual,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopFeatureFlags,
  normalizeDesktopWorkbenchShortcuts,
  normalizeDesktopWorkbenchWindowSnapping
} from "../../../../../../../shared/preferences/index.ts";
import type { DesktopAgentComposerDefaultsPatch } from "../../../../../../../shared/preferences/index.ts";

export interface DesktopPreferencesClient {
  connect(): Promise<void>;
  dispose(): void;
  getDesktopPreferences(): Promise<DesktopPreferencesStateResponse>;
  patchAgentComposerDefaultsForTarget(input: {
    agentTargetId: string;
    clientMutationId: string;
    patch: DesktopAgentComposerDefaultsPatch;
  }): Promise<void>;
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
    patchAgentComposerDefaultsForTarget(input) {
      return eventStreamClient.publishIntent(
        "preferences.agent.composer.defaults.patch.requested",
        input
      );
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
  const workbenchWindowSnapping = normalizeDesktopWorkbenchWindowSnapping(
    preferences.workbenchWindowSnapping
  );
  return [
    // agentComposerDefaultsByProvider is deliberately excluded: the daemon
    // freezes that legacy field (client input is ignored), so including it
    // would make authoritative responses never match pending updates.
    stableAgentGuiConversationRailCollapsedByProviderKey(
      preferences.agentGuiConversationRailCollapsedByProvider
    ),
    normalizeDesktopAgentConversationDetailMode(
      preferences.agentConversationDetailMode
    ),
    preferences.appCatalogChannel,
    preferences.browserUseConnectionMode ?? "isolated",
    preferences.defaultAgentProvider,
    preferences.dockIconStyle,
    preferences.dockPlacement,
    preferences.minimizeAnimation ?? defaultDesktopMinimizeAnimation,
    stableFileDefaultOpenersByExtensionKey(
      preferences.fileDefaultOpenersByExtension
    ),
    stableDesktopFeatureFlagsKey(preferences.featureFlags),
    stableDesktopWorkbenchShortcutsKey(preferences.workbenchShortcuts),
    preferences.locale,
    preferences.sleepPreventionMode,
    preferences.showAppDeveloperSources ? "app-sources:on" : "app-sources:off",
    preferences.themeSource,
    preferences.updateChannel,
    preferences.updatePolicy,
    workbenchWindowSnapping.enabled ? "snapping:on" : "snapping:off",
    workbenchWindowSnapping.shortcutPreset
  ].join("::");
}

function preferencesEqual(
  left: PutDesktopPreferencesRequest["preferences"],
  right: PutDesktopPreferencesRequest["preferences"]
): boolean {
  return (
    // agentComposerDefaultsByProvider is deliberately excluded (frozen
    // server-side; see createPreferencesKey).
    stableAgentGuiConversationRailCollapsedByProviderKey(
      left.agentGuiConversationRailCollapsedByProvider
    ) ===
      stableAgentGuiConversationRailCollapsedByProviderKey(
        right.agentGuiConversationRailCollapsedByProvider
      ) &&
    normalizeDesktopAgentConversationDetailMode(
      left.agentConversationDetailMode
    ) ===
      normalizeDesktopAgentConversationDetailMode(
        right.agentConversationDetailMode
      ) &&
    (left.browserUseConnectionMode ?? "isolated") ===
      (right.browserUseConnectionMode ?? "isolated") &&
    left.appCatalogChannel === right.appCatalogChannel &&
    left.defaultAgentProvider === right.defaultAgentProvider &&
    left.dockIconStyle === right.dockIconStyle &&
    left.dockPlacement === right.dockPlacement &&
    (left.minimizeAnimation ?? defaultDesktopMinimizeAnimation) ===
      (right.minimizeAnimation ?? defaultDesktopMinimizeAnimation) &&
    stableFileDefaultOpenersByExtensionKey(
      left.fileDefaultOpenersByExtension
    ) ===
      stableFileDefaultOpenersByExtensionKey(
        right.fileDefaultOpenersByExtension
      ) &&
    desktopFeatureFlagsEqual(left.featureFlags, right.featureFlags) &&
    desktopWorkbenchShortcutsEqual(
      left.workbenchShortcuts,
      right.workbenchShortcuts
    ) &&
    left.locale === right.locale &&
    left.sleepPreventionMode === right.sleepPreventionMode &&
    (left.showAppDeveloperSources ?? false) ===
      (right.showAppDeveloperSources ?? false) &&
    left.themeSource === right.themeSource &&
    left.updateChannel === right.updateChannel &&
    left.updatePolicy === right.updatePolicy &&
    desktopWorkbenchWindowSnappingEqual(
      left.workbenchWindowSnapping,
      right.workbenchWindowSnapping
    )
  );
}

const desktopAgentProviderKeys = [
  "claude-code",
  "codex",
  "tutti-agent",
  "cursor",
  "nexight",
  "hermes",
  "openclaw"
] as const;

function stableAgentGuiConversationRailCollapsedByProviderKey(
  value: unknown
): string {
  if (!value || typeof value !== "object") {
    return "{}";
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, boolean> = {};
  for (const provider of desktopAgentProviderKeys) {
    if (typeof input[provider] === "boolean") {
      output[provider] = input[provider];
    }
  }
  return JSON.stringify(output);
}

function stableFileDefaultOpenersByExtensionKey(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "{}";
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const extension of Object.keys(input).sort()) {
    const normalizedExtension = extension
      .trim()
      .toLowerCase()
      .replace(/^\.+/u, "");
    const opener = input[extension];
    if (
      /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(normalizedExtension) &&
      typeof opener === "string"
    ) {
      output[normalizedExtension] = opener;
    }
  }
  return JSON.stringify(output);
}

function stableDesktopFeatureFlagsKey(value: unknown): string {
  const normalized = normalizeDesktopFeatureFlags(value);
  const output: Record<string, boolean> = {};
  for (const key of Object.keys(normalized).sort()) {
    output[key] = normalized[key]!;
  }
  return JSON.stringify(output);
}

function stableDesktopWorkbenchShortcutsKey(value: unknown): string {
  return JSON.stringify(normalizeDesktopWorkbenchShortcuts(value));
}
