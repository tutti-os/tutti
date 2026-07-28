import type {
  ReferenceProvenanceCatalog,
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter,
  ReferenceProvenanceOption
} from "../contracts/referenceProvenance.ts";

export interface ReferenceProvenanceAgentLabelParts {
  agentLabel: string;
  ownerLabel: string;
}

export function resolveReferenceProvenanceAgentLabelParts(
  option: ReferenceProvenanceOption,
  memberOptionsById: ReadonlyMap<string, ReferenceProvenanceOption>
): ReferenceProvenanceAgentLabelParts | null {
  if (!option.parentMemberId) return null;

  const ownerLabel = memberOptionsById.get(option.parentMemberId)?.label;
  if (!ownerLabel) return null;

  const prefix = `${ownerLabel} · `;
  if (!option.label.startsWith(prefix)) return null;

  const agentLabel = option.label.slice(prefix.length);
  return agentLabel ? { agentLabel, ownerLabel } : null;
}

export function normalizeReferenceProvenanceCatalog(
  catalog: ReferenceProvenanceCatalog
): ReferenceProvenanceCatalog {
  return {
    enabledDimensions: [...new Set(catalog.enabledDimensions)],
    agentOptions: normalizeReferenceProvenanceOptions(catalog.agentOptions),
    memberOptions: normalizeReferenceProvenanceOptions(catalog.memberOptions)
  };
}

function normalizeReferenceProvenanceOptions(
  options: readonly ReferenceProvenanceOption[]
): readonly ReferenceProvenanceOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const id = option.id.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ ...option, id }];
  });
}

export function normalizeReferenceProvenanceIds(
  ids: readonly string[] | null | undefined,
  options: readonly ReferenceProvenanceOption[]
): readonly string[] | null {
  if (ids == null) return null;
  const available = new Set(
    options
      .filter((option) => !option.disabled)
      .map((option) => option.id.trim())
  );
  const normalized = [
    ...new Set(ids.map((id) => id.trim()).filter((id) => available.has(id)))
  ].sort();
  return normalized.length === available.size && available.size > 0
    ? null
    : normalized;
}

export function normalizeReferenceProvenanceFilter(
  filter: ReferenceProvenanceFilter,
  catalog: ReferenceProvenanceCatalog
): ReferenceProvenanceFilter {
  const normalizedCatalog = normalizeReferenceProvenanceCatalog(catalog);
  const dimensions = new Set(normalizedCatalog.enabledDimensions);
  return {
    agentTargetIds: dimensions.has("agent")
      ? normalizeReferenceProvenanceIds(
          filter.agentTargetIds,
          normalizedCatalog.agentOptions
        )
      : null,
    memberIds: dimensions.has("member")
      ? normalizeReferenceProvenanceIds(
          filter.memberIds,
          normalizedCatalog.memberOptions
        )
      : null
  };
}

export function referenceProvenanceFilterIsActive(
  filter: ReferenceProvenanceFilter | null | undefined
): boolean {
  return Boolean(
    filter && (filter.agentTargetIds !== null || filter.memberIds !== null)
  );
}

export function referenceProvenanceFilterIds(
  filter: ReferenceProvenanceFilter,
  dimension: ReferenceProvenanceDimension
): readonly string[] | null {
  return dimension === "agent" ? filter.agentTargetIds : filter.memberIds;
}

export function withReferenceProvenanceFilterIds(
  filter: ReferenceProvenanceFilter,
  dimension: ReferenceProvenanceDimension,
  ids: readonly string[] | null
): ReferenceProvenanceFilter {
  return dimension === "agent"
    ? { ...filter, agentTargetIds: ids }
    : { ...filter, memberIds: ids };
}

export function referenceProvenanceFilterCacheKey(
  filter: ReferenceProvenanceFilter
): string {
  return JSON.stringify({
    agentTargetIds: normalizedFilterKeyIds(filter.agentTargetIds),
    memberIds: normalizedFilterKeyIds(filter.memberIds)
  });
}

function normalizedFilterKeyIds(
  ids: readonly string[] | null
): readonly string[] | null {
  return ids === null
    ? null
    : [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function toggleReferenceProvenanceFilterId(
  filter: ReferenceProvenanceFilter,
  catalog: ReferenceProvenanceCatalog,
  dimension: ReferenceProvenanceDimension,
  rawId: string
): ReferenceProvenanceFilter {
  const normalizedCatalog = normalizeReferenceProvenanceCatalog(catalog);
  const currentFilter = normalizeReferenceProvenanceFilter(
    filter,
    normalizedCatalog
  );
  const id = rawId.trim();
  const options =
    dimension === "agent"
      ? normalizedCatalog.agentOptions
      : normalizedCatalog.memberOptions;
  const availableIds = options
    .filter((option) => !option.disabled)
    .map((option) => option.id);
  if (!id || !availableIds.includes(id)) return currentFilter;
  const current = referenceProvenanceFilterIds(currentFilter, dimension);
  const next = new Set(current ?? availableIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return normalizeReferenceProvenanceFilter(
    withReferenceProvenanceFilterIds(currentFilter, dimension, [...next]),
    normalizedCatalog
  );
}

export function toggleAllReferenceProvenanceFilterIds(
  filter: ReferenceProvenanceFilter,
  catalog: ReferenceProvenanceCatalog,
  dimension: ReferenceProvenanceDimension
): ReferenceProvenanceFilter {
  const normalizedCatalog = normalizeReferenceProvenanceCatalog(catalog);
  const currentFilter = normalizeReferenceProvenanceFilter(
    filter,
    normalizedCatalog
  );
  const current = referenceProvenanceFilterIds(currentFilter, dimension);
  return normalizeReferenceProvenanceFilter(
    withReferenceProvenanceFilterIds(
      currentFilter,
      dimension,
      current === null ? [] : null
    ),
    normalizedCatalog
  );
}
