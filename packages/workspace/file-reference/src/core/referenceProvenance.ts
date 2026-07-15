import type {
  ReferenceProvenanceCatalog,
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter,
  ReferenceProvenanceOption
} from "../contracts/referenceProvenance.ts";

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
  const dimensions = new Set(catalog.enabledDimensions);
  return {
    agentTargetIds: dimensions.has("agent")
      ? normalizeReferenceProvenanceIds(
          filter.agentTargetIds,
          catalog.agentOptions
        )
      : null,
    memberIds: dimensions.has("member")
      ? normalizeReferenceProvenanceIds(filter.memberIds, catalog.memberOptions)
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
  return [
    `agents:${filter.agentTargetIds?.join(",") ?? "*"}`,
    `members:${filter.memberIds?.join(",") ?? "*"}`
  ].join("|");
}
