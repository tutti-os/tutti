import type {
  WorkspaceFileLocation,
  WorkspaceFileLocationSection
} from "@tutti-os/workspace-file-manager/services";
import type {
  ListChildrenInput,
  ListChildrenResult,
  NodeRef,
  ReferenceNode,
  ReferencePreview,
  ReferenceScope,
  ReferenceSourceService,
  SearchInput,
  SearchResult,
  SelectedReference,
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter
} from "@tutti-os/workspace-file-reference/contracts";
import {
  matchesFilterCategories,
  normalizeReferenceNodeKind
} from "@tutti-os/workspace-file-reference/core";
import {
  DESKTOP_WORKSPACE_FILE_LOCAL_SECTION_ID,
  DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID,
  findDesktopWorkspaceFileLocationByProject
} from "../workspace-file-manager/services/desktopWorkspaceFileLocations.ts";

export const WORKSPACE_FILE_SOURCE_ID = "workspace-file";
export const USER_PROJECT_REFERENCE_SOURCE_ID = "user-project";

const RECENT_GROUP_NODE_ID = "__recent__";
const RECENT_REFERENCE_LIMIT = 100;

export function createWorkspaceFileLocationReferenceSources(input: {
  adapter: WorkspaceFileReferenceAdapter;
  getLocationSections: () =>
    | Promise<WorkspaceFileLocationSection[]>
    | WorkspaceFileLocationSection[];
  localLabel: string;
  localOrder?: number;
  projectLabel: string;
  projectOrder?: number;
  searchByProvenance?: (
    scope: ReferenceScope,
    input: SearchInput
  ) => Promise<WorkspaceFileReference[]>;
}): ReferenceSourceService[] {
  return [
    createLocationReferenceSource({
      adapter: input.adapter,
      getLocationSections: input.getLocationSections,
      label: input.projectLabel,
      order: input.projectOrder ?? -1,
      searchByProvenance: input.searchByProvenance,
      sectionId: DESKTOP_WORKSPACE_FILE_PROJECT_SECTION_ID,
      sourceId: USER_PROJECT_REFERENCE_SOURCE_ID
    }),
    createLocationReferenceSource({
      adapter: input.adapter,
      getLocationSections: input.getLocationSections,
      label: input.localLabel,
      order: input.localOrder ?? 0,
      searchByProvenance: input.searchByProvenance,
      sectionId: DESKTOP_WORKSPACE_FILE_LOCAL_SECTION_ID,
      sourceId: WORKSPACE_FILE_SOURCE_ID
    })
  ];
}

function createLocationReferenceSource(input: {
  adapter: WorkspaceFileReferenceAdapter;
  getLocationSections: () =>
    | Promise<WorkspaceFileLocationSection[]>
    | WorkspaceFileLocationSection[];
  label: string;
  order: number;
  sectionId: string;
  sourceId: string;
  searchByProvenance?: (
    scope: ReferenceScope,
    input: SearchInput
  ) => Promise<WorkspaceFileReference[]>;
}): ReferenceSourceService {
  const { adapter, sourceId } = input;

  async function getSection(): Promise<WorkspaceFileLocationSection | null> {
    const sections = await input.getLocationSections();
    return sections.find((section) => section.id === input.sectionId) ?? null;
  }

  function referenceToNode(ref: WorkspaceFileReference): ReferenceNode {
    const kind = normalizeReferenceNodeKind(ref.kind);
    return {
      ref: { sourceId, nodeId: ref.path },
      kind,
      displayName: ref.displayName?.trim() || basename(ref.path),
      ...(kind === "folder" ? { hasChildren: true } : {}),
      ...(ref.createdTimeMs == null
        ? {}
        : { createdTimeMs: ref.createdTimeMs }),
      ...(ref.sizeBytes == null ? {} : { sizeBytes: ref.sizeBytes }),
      ...(ref.mtimeMs == null ? {} : { mtimeMs: ref.mtimeMs })
    };
  }

  function nodeToReference(node: ReferenceNode): WorkspaceFileReference {
    return { path: node.ref.nodeId, kind: node.kind };
  }

  return {
    metadata: {
      id: sourceId,
      label: input.label,
      order: input.order
    },
    capabilities: {
      searchable: true,
      previewable: true,
      paginated: false,
      navigable: false,
      filterable: true,
      ...(input.searchByProvenance
        ? { provenanceDimensions: ["agent"] as const }
        : {})
    },

    async isAvailable() {
      const section = await getSection();
      return section !== null && section.locations.length > 0;
    },

    listSidebarGroups(): ReferenceNode[] {
      // The picker calls this synchronously. The source registry has already
      // resolved availability, so use the latest synchronous snapshot available
      // from the getLocationSections provider.
      const sections = input.getLocationSections();
      if (sections instanceof Promise) {
        return [];
      }
      const section =
        sections.find((item) => item.id === input.sectionId) ?? null;
      return locationNodes(section?.locations ?? [], sourceId);
    },

    async listChildren(
      scope: ReferenceScope,
      { node, signal }: ListChildrenInput
    ): Promise<ListChildrenResult> {
      if (!node) {
        const section = await getSection();
        return {
          entries: locationNodes(section?.locations ?? [], sourceId),
          nextCursor: null,
          ordered: true
        };
      }
      if (node.nodeId === RECENT_GROUP_NODE_ID) {
        if (!adapter.listRecentReferences) {
          return { entries: [], nextCursor: null, ordered: true };
        }
        const refs = await adapter.listRecentReferences({
          workspaceId: scope.workspaceId,
          limit: RECENT_REFERENCE_LIMIT,
          ...(signal ? { signal } : {})
        });
        return {
          entries: refs.map(referenceToNode),
          nextCursor: null,
          ordered: true
        };
      }
      if (!adapter.listDirectory) {
        return { entries: [], nextCursor: null };
      }
      const listing = await adapter.listDirectory({
        workspaceId: scope.workspaceId,
        path: node.nodeId
      });
      return {
        entries: listing.entries.map(referenceToNode),
        nextCursor: null
      };
    },

    async locateTarget(
      _scope: ReferenceScope,
      params: Record<string, string>
    ): Promise<NodeRef[] | null> {
      const location =
        sourceId === USER_PROJECT_REFERENCE_SOURCE_ID
          ? findDesktopWorkspaceFileLocationByProject({
              locationSections: await input.getLocationSections(),
              projectId: params.projectId,
              projectPath: params.projectPath
            })
          : await findLocationForLocateTarget({
              getSection,
              locationId: params.locationId,
              referenceNodeId: params.referenceNodeId
            });
      if (!location || location.kind !== "directory") {
        return null;
      }
      return [
        {
          sourceId,
          nodeId: location.referenceNodeId
        }
      ];
    },

    async search(
      scope: ReferenceScope,
      searchInput: SearchInput
    ): Promise<SearchResult> {
      const {
        query,
        filters,
        kinds,
        limit,
        provenanceFilter,
        signal,
        withinNodeId
      } = searchInput;
      if (
        input.searchByProvenance &&
        provenanceFilter !== null &&
        provenanceFilter !== undefined &&
        provenanceFilter.agentTargetIds !== null
      ) {
        const refs = await input.searchByProvenance(scope, searchInput);
        const filtered = refs.filter((ref) =>
          matchesRecentReferenceSearch(ref, "", filters ?? [], kinds)
        );
        return {
          entries: (limit === undefined
            ? filtered
            : filtered.slice(0, limit)
          ).map(referenceToNode),
          nextCursor: null
        };
      }
      if (withinNodeId === RECENT_GROUP_NODE_ID) {
        if (!adapter.listRecentReferences) {
          return { entries: [], nextCursor: null };
        }
        const normalizedQuery = query.trim().toLowerCase();
        const refs = await adapter.listRecentReferences({
          workspaceId: scope.workspaceId,
          limit: RECENT_REFERENCE_LIMIT,
          ...(signal ? { signal } : {})
        });
        const filteredRefs = refs.filter((ref) =>
          matchesRecentReferenceSearch(
            ref,
            normalizedQuery,
            filters ?? [],
            kinds
          )
        );
        return {
          entries:
            limit === undefined
              ? filteredRefs.map(referenceToNode)
              : filteredRefs.slice(0, limit).map(referenceToNode),
          nextCursor: null
        };
      }
      if (!adapter.searchReferences) {
        return { entries: [], nextCursor: null };
      }
      const searchLocations = await resolveSearchLocations({
        getSection,
        withinNodeId
      });
      const entries: ReferenceNode[] = [];
      const seen = new Set<string>();
      const resultLimit = limit ?? 30;
      for (const location of searchLocations) {
        if (entries.length >= resultLimit) {
          break;
        }
        const refs = await adapter.searchReferences({
          workspaceId: scope.workspaceId,
          query,
          ...(kinds && kinds.length > 0 ? { kinds } : {}),
          ...(filters && filters.length > 0 ? { filters } : {}),
          ...(location?.kind === "directory"
            ? { within: location.referenceNodeId }
            : {}),
          limit: resultLimit,
          ...(signal ? { signal } : {})
        });
        for (const ref of refs) {
          if (seen.has(ref.path)) {
            continue;
          }
          seen.add(ref.path);
          entries.push(referenceToNode(ref));
          if (entries.length >= resultLimit) {
            break;
          }
        }
      }
      return { entries, nextCursor: null };
    },

    async open(_scope: ReferenceScope, node: ReferenceNode): Promise<void> {
      await adapter.openReference?.(nodeToReference(node));
    },

    async listOpenWithApplications(
      _scope: ReferenceScope,
      node: ReferenceNode
    ) {
      return (
        (await adapter.listOpenWithApplications?.(nodeToReference(node))) ?? []
      );
    },

    async openWithApplication(
      _scope: ReferenceScope,
      node: ReferenceNode,
      applicationPath: string
    ): Promise<void> {
      await adapter.openReferenceWithApplication?.(
        nodeToReference(node),
        applicationPath
      );
    },

    async openWithOtherApplication(
      _scope: ReferenceScope,
      node: ReferenceNode,
      applicationPickerPrompt?: string
    ): Promise<void> {
      await adapter.openReferenceWithOtherApplication?.(
        nodeToReference(node),
        applicationPickerPrompt
      );
    },

    async reveal(_scope: ReferenceScope, node: ReferenceNode): Promise<void> {
      await adapter.revealReference?.(nodeToReference(node));
    },

    async readPreview(
      scope: ReferenceScope,
      node: ReferenceNode
    ): Promise<ReferencePreview | null> {
      if (!adapter.readReferencePreview) {
        return null;
      }
      return adapter.readReferencePreview({
        workspaceId: scope.workspaceId,
        reference: nodeToReference(node)
      });
    },

    resolveSelection(node: ReferenceNode): SelectedReference {
      return {
        path: node.ref.nodeId,
        kind: node.kind,
        ...(node.displayName ? { displayName: node.displayName } : {})
      };
    }
  };
}

function locationNodes(
  locations: readonly WorkspaceFileLocation[],
  sourceId: string
): ReferenceNode[] {
  return locations
    .filter(
      (
        location
      ): location is Extract<
        WorkspaceFileLocation,
        { kind: "directory" | "recent" }
      > => location.kind === "directory" || location.kind === "recent"
    )
    .map((location) => ({
      ref: {
        sourceId,
        nodeId:
          location.kind === "recent"
            ? RECENT_GROUP_NODE_ID
            : location.referenceNodeId
      },
      kind: "folder",
      displayName: location.label,
      ...(location.contextLabel ? { contextLabel: location.contextLabel } : {}),
      hasChildren: true
    }));
}

async function resolveSearchLocations(input: {
  getSection: () => Promise<WorkspaceFileLocationSection | null>;
  withinNodeId?: string | null;
}): Promise<Array<WorkspaceFileLocation | null>> {
  const section = await input.getSection();
  if (!input.withinNodeId) {
    const directoryLocations =
      section?.locations.filter((location) => location.kind === "directory") ??
      [];
    return directoryLocations.length > 0 ? directoryLocations : [null];
  }
  const location =
    section?.locations.find(
      (item) =>
        item.kind === "directory" && item.referenceNodeId === input.withinNodeId
    ) ?? null;
  return [location];
}

async function findLocationForLocateTarget(input: {
  getSection: () => Promise<WorkspaceFileLocationSection | null>;
  locationId?: string | null;
  referenceNodeId?: string | null;
}): Promise<WorkspaceFileLocation | null> {
  const section = await input.getSection();
  return (
    section?.locations.find((location) => {
      if (input.locationId && location.id === input.locationId) {
        return true;
      }
      return (
        location.kind === "directory" &&
        input.referenceNodeId &&
        location.referenceNodeId === input.referenceNodeId
      );
    }) ?? null
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function matchesRecentReferenceSearch(
  ref: WorkspaceFileReference,
  query: string,
  filters: readonly string[],
  kinds?: readonly ReferenceNode["kind"][]
): boolean {
  const name = ref.displayName?.trim() || basename(ref.path);
  const isFolder = normalizeReferenceNodeKind(ref.kind) === "folder";
  if (
    kinds &&
    kinds.length > 0 &&
    !kinds.includes(isFolder ? "folder" : "file")
  ) {
    return false;
  }
  if (!matchesFilterCategories(name, isFolder, filters)) {
    return false;
  }
  return query.length === 0 || name.toLowerCase().includes(query);
}
