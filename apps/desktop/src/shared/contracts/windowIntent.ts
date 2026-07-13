import type { DesktopLocale } from "../i18n";
import type { DesktopDockPlacement } from "../preferences/index.ts";
import type {
  DesktopThemeAppearance,
  DesktopThemeSource
} from "../theme/index.ts";
import {
  isDesktopFusionWindowKind,
  type DesktopFusionWindowKind
} from "./fusion.ts";

export type DesktopWindowIntent =
  | {
      kind: "workspace";
      workspaceID: string;
    }
  | {
      launchPayload?: unknown;
      kind: "agent";
      resourceID: string | null;
      windowInstanceID?: string | null;
      workspaceID: string;
    }
  | {
      kind: "fusion-dock";
      workspaceID: string;
    }
  | {
      fusionWindowKind: DesktopFusionWindowKind;
      kind: "fusion-tool";
      launchPayload?: unknown;
      resourceID?: string | null;
      windowInstanceID: string;
      workspaceID: string;
    }
  | {
      kind: "workspace-missing";
    };

export interface DesktopWindowIntentSearchOptions {
  dockPlacement?: DesktopDockPlacement;
  locale?: DesktopLocale;
  themeAppearance?: DesktopThemeAppearance;
  themeSource?: DesktopThemeSource;
}

export function createWorkspaceWindowIntent(
  workspaceID: string
): DesktopWindowIntent {
  return {
    kind: "workspace",
    workspaceID
  };
}

export function createAgentWindowIntent(input: {
  launchPayload?: unknown;
  resourceID?: string | null;
  windowInstanceID?: string | null;
  workspaceID: string;
}): DesktopWindowIntent {
  const windowInstanceID = input.windowInstanceID?.trim() || null;
  return {
    ...(input.launchPayload === undefined
      ? {}
      : { launchPayload: input.launchPayload }),
    kind: "agent",
    resourceID: input.resourceID?.trim() || null,
    ...(windowInstanceID ? { windowInstanceID } : {}),
    workspaceID: input.workspaceID.trim()
  };
}

export function createFusionDockWindowIntent(
  workspaceID: string
): DesktopWindowIntent {
  return { kind: "fusion-dock", workspaceID };
}

export function createFusionToolWindowIntent(input: {
  fusionWindowKind: DesktopFusionWindowKind;
  launchPayload?: unknown;
  resourceID?: string | null;
  windowInstanceID: string;
  workspaceID: string;
}): DesktopWindowIntent {
  return {
    fusionWindowKind: input.fusionWindowKind,
    kind: "fusion-tool",
    ...(input.launchPayload === undefined
      ? {}
      : { launchPayload: input.launchPayload }),
    resourceID: input.resourceID?.trim() || null,
    windowInstanceID: input.windowInstanceID.trim(),
    workspaceID: input.workspaceID.trim()
  };
}

export function encodeDesktopWindowIntent(
  intent: DesktopWindowIntent,
  options: DesktopWindowIntentSearchOptions = {}
): string {
  const params = new URLSearchParams();

  if (options.locale) {
    params.set("lang", options.locale);
  }
  if (options.dockPlacement) {
    params.set("dockPlacement", options.dockPlacement);
  }
  if (options.themeSource) {
    params.set("themeSource", options.themeSource);
  }
  if (options.themeAppearance) {
    params.set("theme", options.themeAppearance);
  }

  if (intent.kind === "agent") {
    params.set("view", "agent");
    params.set("workspaceId", intent.workspaceID);
    if (intent.resourceID) {
      params.set("fusionResourceId", intent.resourceID);
    }
    if (intent.windowInstanceID) {
      params.set("fusionWindowId", intent.windowInstanceID);
    }
    if (intent.launchPayload !== undefined) {
      params.set("fusionLaunchPayload", JSON.stringify(intent.launchPayload));
    }
  } else if (intent.kind === "fusion-dock") {
    params.set("view", "fusion-dock");
    params.set("workspaceId", intent.workspaceID);
  } else if (intent.kind === "fusion-tool") {
    params.set("view", "fusion-tool");
    params.set("workspaceId", intent.workspaceID);
    params.set("fusionWindowId", intent.windowInstanceID);
    params.set("fusionWindowKind", intent.fusionWindowKind);
    if (intent.resourceID) {
      params.set("fusionResourceId", intent.resourceID);
    }
    if (intent.launchPayload !== undefined) {
      params.set("fusionLaunchPayload", JSON.stringify(intent.launchPayload));
    }
  } else {
    params.set("view", "workspace");
    if (intent.kind === "workspace") {
      params.set("workspaceId", intent.workspaceID);
    }
  }

  return params.toString();
}

export function applyDesktopWindowIntent(
  baseUrl: string,
  intent: DesktopWindowIntent,
  options: DesktopWindowIntentSearchOptions = {}
): string {
  const url = new URL(baseUrl);
  url.search = encodeDesktopWindowIntent(intent, options);
  return url.toString();
}

export function resolveDesktopWindowIntent(
  search: string
): DesktopWindowIntent {
  const params = new URLSearchParams(search);
  const view = params.get("view");

  if (
    view !== "workspace" &&
    view !== "agent" &&
    view !== "fusion-dock" &&
    view !== "fusion-tool"
  ) {
    return {
      kind: "workspace-missing"
    };
  }

  const workspaceID = params.get("workspaceId")?.trim();
  if (!workspaceID) {
    return {
      kind: "workspace-missing"
    };
  }

  if (view === "agent") {
    return createAgentWindowIntent({
      launchPayload: parseFusionLaunchPayload(
        params.get("fusionLaunchPayload")
      ),
      resourceID: params.get("fusionResourceId"),
      windowInstanceID: params.get("fusionWindowId"),
      workspaceID
    });
  }

  if (view === "fusion-dock") {
    return createFusionDockWindowIntent(workspaceID);
  }

  if (view === "fusion-tool") {
    const windowInstanceID = params.get("fusionWindowId")?.trim();
    const fusionWindowKind = params.get("fusionWindowKind");
    if (!windowInstanceID || !isDesktopFusionWindowKind(fusionWindowKind)) {
      return { kind: "workspace-missing" };
    }
    return createFusionToolWindowIntent({
      fusionWindowKind,
      launchPayload: parseFusionLaunchPayload(
        params.get("fusionLaunchPayload")
      ),
      resourceID: params.get("fusionResourceId"),
      windowInstanceID,
      workspaceID
    });
  }

  return createWorkspaceWindowIntent(workspaceID);
}

function parseFusionLaunchPayload(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
