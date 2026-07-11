import type {
  DesktopWorkspaceAppContext,
  DesktopWorkspaceAppContextPatch
} from "../../shared/contracts/ipc.ts";
import { isDesktopLocale } from "../../shared/i18n/core/locale.ts";
import type { TuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/contracts";
import { normalizeTuttiExternalWorkspaceOpenRouteIntent } from "@tutti-os/workspace-external-core/core";

interface WorkspaceAppContextStoreOptions {
  load(): Promise<DesktopWorkspaceAppContext>;
}

interface WorkspaceAppContextSubscription {
  listener: (context: DesktopWorkspaceAppContext) => void;
  revision: number;
}

export interface WorkspaceAppContextStore {
  get(): Promise<DesktopWorkspaceAppContext>;
  publish(patch: DesktopWorkspaceAppContextPatch): void;
  subscribe(
    listener: (context: DesktopWorkspaceAppContext) => void
  ): () => void;
}

export function createWorkspaceAppContextStore(
  options: WorkspaceAppContextStoreOptions
): WorkspaceAppContextStore {
  const subscriptions = new Set<WorkspaceAppContextSubscription>();
  let cachedContext: DesktopWorkspaceAppContext | null = null;
  let pendingContext: Promise<DesktopWorkspaceAppContext> | null = null;
  let pendingPatch: DesktopWorkspaceAppContextPatch = {};
  let revision = 0;

  const get = async (): Promise<DesktopWorkspaceAppContext> => {
    if (cachedContext) {
      return cachedContext;
    }
    if (pendingContext) {
      const context = await pendingContext;
      return cachedContext ?? context;
    }

    pendingContext = options.load().then((context) => {
      cachedContext = { ...context, ...pendingPatch };
      pendingPatch = {};
      return cachedContext;
    });
    try {
      const context = await pendingContext;
      return cachedContext ?? context;
    } finally {
      pendingContext = null;
    }
  };

  return {
    get,
    publish(patch) {
      revision += 1;
      if (!cachedContext) {
        pendingPatch = { ...pendingPatch, ...patch };
        return;
      }

      cachedContext = { ...cachedContext, ...patch };
      for (const subscription of subscriptions) {
        subscription.revision = revision;
        subscription.listener(cachedContext);
      }
    },
    subscribe(listener) {
      const subscription: WorkspaceAppContextSubscription = {
        listener,
        revision: -1
      };
      subscriptions.add(subscription);
      void get().then(
        (context) => {
          if (
            subscriptions.has(subscription) &&
            subscription.revision < revision
          ) {
            subscription.revision = revision;
            subscription.listener(cachedContext ?? context);
          }
        },
        () => undefined
      );

      return () => {
        subscriptions.delete(subscription);
      };
    }
  };
}

export function isWorkspaceAppContext(
  value: unknown
): value is DesktopWorkspaceAppContext {
  if (!isRecord(value) || !isDesktopLocale(value.locale)) {
    return false;
  }
  return (
    isOptionalBoolean(value.agentBound) &&
    isOptionalString(value.appId) &&
    isOptionalStringArray(value.capabilities) &&
    isOptionalString(value.contextToken) &&
    isOptionalString(value.installationId) &&
    isOptionalString(value.issuer) &&
    isOptionalWorkspaceOpenRouteIntent(value.launchIntent) &&
    isOptionalString(value.workspaceId)
  );
}

export function isWorkspaceAppContextPatch(
  value: unknown
): value is DesktopWorkspaceAppContextPatch {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "agentBound" && key !== "locale")
  ) {
    return false;
  }
  return (
    (!("agentBound" in value) || typeof value.agentBound === "boolean") &&
    (!("locale" in value) || isDesktopLocale(value.locale))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function isOptionalWorkspaceOpenRouteIntent(
  value: unknown
): value is TuttiExternalWorkspaceOpenRouteIntent | undefined {
  if (value === undefined) {
    return true;
  }
  try {
    normalizeTuttiExternalWorkspaceOpenRouteIntent(value);
    return true;
  } catch {
    return false;
  }
}
