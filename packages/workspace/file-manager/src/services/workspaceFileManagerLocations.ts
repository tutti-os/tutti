import type {
  WorkspaceFileLocation,
  WorkspaceFileLocationSection
} from "./workspaceFileManagerTypes.ts";

export function flattenWorkspaceFileLocations(
  sections: readonly WorkspaceFileLocationSection[]
): WorkspaceFileLocation[] {
  return sections.flatMap((section) => section.locations);
}

export function findWorkspaceFileLocationById(
  sections: readonly WorkspaceFileLocationSection[],
  locationId: string | null | undefined
): WorkspaceFileLocation | null {
  if (!locationId) {
    return null;
  }
  return (
    flattenWorkspaceFileLocations(sections).find(
      (location) => location.id === locationId
    ) ?? null
  );
}

export function resolveWorkspaceFileLocationDefaultId(input: {
  defaultLocationId?: string | null;
  fallbackToFirst?: boolean;
  persistedLocationId?: string | null;
  sections: readonly WorkspaceFileLocationSection[];
}): string | null {
  const { sections } = input;
  const persisted = findWorkspaceFileLocationById(
    sections,
    input.persistedLocationId
  );
  if (persisted) {
    return persisted.id;
  }

  const preferred = findWorkspaceFileLocationById(
    sections,
    input.defaultLocationId
  );
  if (preferred) {
    return preferred.id;
  }

  if (input.fallbackToFirst === false) {
    return null;
  }
  return flattenWorkspaceFileLocations(sections)[0]?.id ?? null;
}

export function isWorkspaceFileRecentLocation(
  location: WorkspaceFileLocation | null | undefined
): boolean {
  return location?.kind === "recent";
}

export function isWorkspaceFileExternalLocation(
  location: WorkspaceFileLocation | null | undefined
): boolean {
  return location?.kind === "external";
}
