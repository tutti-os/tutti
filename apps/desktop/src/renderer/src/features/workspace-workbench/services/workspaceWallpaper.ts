import type { DesktopI18nKey } from "@shared/i18n";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import type { WorkbenchSurfaceWallpaperFit } from "@tutti-os/workbench-surface";

export type WorkspaceWallpaperId =
  | "default"
  | "tutti"
  | "ocean"
  | "sky"
  | "peaks"
  | "orbit"
  | "sand"
  | "dunes"
  | "custom";

export const customWorkspaceWallpaperId: WorkspaceWallpaperId = "custom";
export const defaultWorkspaceWallpaperId: WorkspaceWallpaperId = "tutti";
const customWorkspaceWallpaperTitleKey: DesktopI18nKey =
  "workspace.wallpaper.options.custom";

export type WorkspaceWallpaperAppearance = "light" | "dark";

export const workspaceWallpaperDisplayModes = [
  "original",
  "fit",
  "stretch",
  "center"
] as const;

export type WorkspaceWallpaperDisplayMode =
  | (typeof workspaceWallpaperDisplayModes)[number]
  | "fill";

const defaultWorkspaceWallpaperDisplayMode: WorkspaceWallpaperDisplayMode =
  "original";

function isWorkspaceWallpaperDisplayMode(
  value: string
): value is WorkspaceWallpaperDisplayMode {
  return (
    workspaceWallpaperDisplayModes.includes(
      value as (typeof workspaceWallpaperDisplayModes)[number]
    ) || value === "fill"
  );
}

export function workspaceWallpaperDisplayModeTitleKey(
  mode: WorkspaceWallpaperDisplayMode
): DesktopI18nKey {
  if (mode === "fill") {
    return "workspace.settings.appearance.wallpaperDisplayModeOptions.original";
  }

  return `workspace.settings.appearance.wallpaperDisplayModeOptions.${mode}`;
}

export function toWorkbenchSurfaceWallpaperFit(
  mode: WorkspaceWallpaperDisplayMode
): WorkbenchSurfaceWallpaperFit {
  switch (mode) {
    case "fill":
      return "cover";
    case "original":
    case "center":
      return "center";
    case "fit":
      return "contain";
    case "stretch":
      return "stretch";
  }
}

export function resolveWorkspaceWallpaperDisplayMode(
  wallpaperID: WorkspaceWallpaperId,
  displayMode: WorkspaceWallpaperDisplayMode
): WorkspaceWallpaperDisplayMode {
  if (wallpaperID !== customWorkspaceWallpaperId) {
    return "fill";
  }

  return displayMode;
}

export interface WorkspaceWallpaperOption {
  appearance: WorkspaceWallpaperAppearance;
  darkUrl?: string;
  id: WorkspaceWallpaperId;
  titleKey: DesktopI18nKey;
  url: string;
}

const workspaceWallpaperMetadataKey = "workspaceWallpaper";
const workspaceWallpaperMetadataSchemaVersion = 1;

export const workspaceWallpaperOptions: WorkspaceWallpaperOption[] = [
  {
    appearance: "dark",
    id: "tutti",
    titleKey: "workspace.wallpaper.options.tutti",
    url: new URL(
      "../../../assets/workspace-wallpaper/tutti.png",
      import.meta.url
    ).href
  },
  {
    appearance: "light",
    id: "default",
    titleKey: "workspace.wallpaper.options.default",
    darkUrl: new URL(
      "../../../assets/workspace-wallpaper/default-dark.png",
      import.meta.url
    ).href,
    url: new URL(
      "../../../assets/workspace-wallpaper/default-light.png",
      import.meta.url
    ).href
  },
  {
    appearance: "dark",
    id: "ocean",
    titleKey: "workspace.wallpaper.options.ocean",
    url: new URL(
      "../../../assets/workspace-wallpaper/ocean.png",
      import.meta.url
    ).href
  },
  {
    appearance: "light",
    id: "sky",
    titleKey: "workspace.wallpaper.options.sky",
    url: new URL("../../../assets/workspace-wallpaper/sky.png", import.meta.url)
      .href
  },
  {
    appearance: "dark",
    id: "peaks",
    titleKey: "workspace.wallpaper.options.peaks",
    url: new URL(
      "../../../assets/workspace-wallpaper/peaks.png",
      import.meta.url
    ).href
  },
  {
    appearance: "dark",
    id: "orbit",
    titleKey: "workspace.wallpaper.options.orbit",
    url: new URL(
      "../../../assets/workspace-wallpaper/orbit.png",
      import.meta.url
    ).href
  },
  {
    appearance: "light",
    id: "sand",
    titleKey: "workspace.wallpaper.options.sand",
    url: new URL(
      "../../../assets/workspace-wallpaper/sand.png",
      import.meta.url
    ).href
  },
  {
    appearance: "dark",
    id: "dunes",
    titleKey: "workspace.wallpaper.options.dunes",
    url: new URL(
      "../../../assets/workspace-wallpaper/dunes.png",
      import.meta.url
    ).href
  }
];

function isWorkspaceWallpaperId(value: string): value is WorkspaceWallpaperId {
  return (
    value === customWorkspaceWallpaperId ||
    workspaceWallpaperOptions.some((option) => option.id === value)
  );
}

export function getWorkspaceWallpaperOption(
  id: WorkspaceWallpaperId,
  appearance: WorkspaceWallpaperAppearance = "light",
  customWallpaperUrl?: string | null
): WorkspaceWallpaperOption {
  if (id === customWorkspaceWallpaperId) {
    if (customWallpaperUrl) {
      return {
        appearance,
        id: customWorkspaceWallpaperId,
        titleKey: customWorkspaceWallpaperTitleKey,
        url: customWallpaperUrl
      };
    }
    return getWorkspaceWallpaperOption("default", appearance);
  }

  const option = workspaceWallpaperOptions.find((item) => item.id === id);
  if (option) {
    return resolveWorkspaceWallpaperOption(option, appearance);
  }
  const fallback = workspaceWallpaperOptions[0];
  if (!fallback) {
    throw new Error("Workspace wallpaper catalog is empty.");
  }
  return resolveWorkspaceWallpaperOption(fallback, appearance);
}

function resolveWorkspaceWallpaperOption(
  option: WorkspaceWallpaperOption,
  appearance: WorkspaceWallpaperAppearance
): WorkspaceWallpaperOption {
  if (option.id !== "default" || appearance !== "dark" || !option.darkUrl) {
    return option;
  }

  return {
    ...option,
    appearance: "dark",
    url: option.darkUrl
  };
}

export function readWorkspaceWallpaperIdFromSnapshot(
  snapshot: WorkbenchSnapshot | null | undefined
): WorkspaceWallpaperId {
  return readWorkspaceWallpaperSnapshotMetadata(snapshot).selectedWallpaperID;
}

export function readWorkspaceWallpaperDisplayModeFromSnapshot(
  snapshot: WorkbenchSnapshot | null | undefined
): WorkspaceWallpaperDisplayMode {
  return readWorkspaceWallpaperSnapshotMetadata(snapshot).displayMode;
}

export function writeWorkspaceWallpaperIdToSnapshot(
  snapshot: WorkbenchSnapshot,
  wallpaperID: WorkspaceWallpaperId
): WorkbenchSnapshot {
  return writeWorkspaceWallpaperSnapshotMetadata(snapshot, {
    selectedWallpaperID: wallpaperID
  });
}

export function writeWorkspaceWallpaperDisplayModeToSnapshot(
  snapshot: WorkbenchSnapshot,
  displayMode: WorkspaceWallpaperDisplayMode
): WorkbenchSnapshot {
  return writeWorkspaceWallpaperSnapshotMetadata(snapshot, {
    displayMode
  });
}

export function preserveWorkspaceWallpaperSnapshotMetadata(
  previousSnapshot: WorkbenchSnapshot | null | undefined,
  nextSnapshot: WorkbenchSnapshot
): WorkbenchSnapshot {
  if (nextSnapshot.metadata?.[workspaceWallpaperMetadataKey] !== undefined) {
    return nextSnapshot;
  }

  const wallpaperMetadata =
    previousSnapshot?.metadata?.[workspaceWallpaperMetadataKey];
  if (wallpaperMetadata === undefined) {
    return nextSnapshot;
  }

  return {
    ...nextSnapshot,
    metadata: {
      ...(nextSnapshot.metadata ?? {}),
      [workspaceWallpaperMetadataKey]: wallpaperMetadata
    }
  };
}

export function replaceWorkspaceWallpaperSnapshotMetadata(
  authoritativeSnapshot: WorkbenchSnapshot | null | undefined,
  nextSnapshot: WorkbenchSnapshot
): WorkbenchSnapshot {
  const authoritativeMetadata =
    authoritativeSnapshot?.metadata?.[workspaceWallpaperMetadataKey];
  const {
    [workspaceWallpaperMetadataKey]: _discardedWallpaperMetadata,
    ...nextMetadata
  } = nextSnapshot.metadata ?? {};

  return {
    ...nextSnapshot,
    metadata:
      authoritativeMetadata === undefined
        ? nextMetadata
        : {
            ...nextMetadata,
            [workspaceWallpaperMetadataKey]: authoritativeMetadata
          }
  };
}

interface WorkspaceWallpaperSnapshotMetadata {
  displayMode: WorkspaceWallpaperDisplayMode;
  schemaVersion: typeof workspaceWallpaperMetadataSchemaVersion;
  selectedWallpaperID: WorkspaceWallpaperId;
}

function readWorkspaceWallpaperSnapshotMetadata(
  snapshot: WorkbenchSnapshot | null | undefined
): WorkspaceWallpaperSnapshotMetadata {
  const metadata = snapshot?.metadata?.[workspaceWallpaperMetadataKey];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return createDefaultWorkspaceWallpaperSnapshotMetadata();
  }

  const raw = metadata as Partial<WorkspaceWallpaperSnapshotMetadata>;
  const selectedWallpaperID = raw.selectedWallpaperID;
  const displayMode = raw.displayMode;

  return {
    schemaVersion: workspaceWallpaperMetadataSchemaVersion,
    selectedWallpaperID:
      typeof selectedWallpaperID === "string" &&
      isWorkspaceWallpaperId(selectedWallpaperID)
        ? selectedWallpaperID
        : defaultWorkspaceWallpaperId,
    displayMode:
      typeof displayMode === "string" &&
      isWorkspaceWallpaperDisplayMode(displayMode)
        ? displayMode
        : defaultWorkspaceWallpaperDisplayMode
  };
}

function writeWorkspaceWallpaperSnapshotMetadata(
  snapshot: WorkbenchSnapshot,
  patch: Partial<WorkspaceWallpaperSnapshotMetadata>
): WorkbenchSnapshot {
  const current = readWorkspaceWallpaperSnapshotMetadata(snapshot);

  return {
    ...snapshot,
    metadata: {
      ...(snapshot.metadata ?? {}),
      [workspaceWallpaperMetadataKey]: {
        ...current,
        ...patch,
        schemaVersion: workspaceWallpaperMetadataSchemaVersion
      } satisfies WorkspaceWallpaperSnapshotMetadata
    }
  };
}

function createDefaultWorkspaceWallpaperSnapshotMetadata(): WorkspaceWallpaperSnapshotMetadata {
  return {
    schemaVersion: workspaceWallpaperMetadataSchemaVersion,
    selectedWallpaperID: defaultWorkspaceWallpaperId,
    displayMode: defaultWorkspaceWallpaperDisplayMode
  };
}
