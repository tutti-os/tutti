export type ReferenceProvenanceDimension = "agent" | "member";

export interface ReferenceProvenanceFilter {
  /** null means this dimension does not constrain the query. */
  agentTargetIds: readonly string[] | null;
  /** Reserved for collaboration hosts. Personal Tutti does not enable it. */
  memberIds: readonly string[] | null;
}

export interface ReferenceProvenanceOption {
  id: string;
  label: string;
  iconUrl?: string | null;
  disabled?: boolean;
  /** Lets collaboration hosts describe ownership without changing filter semantics. */
  parentMemberId?: string | null;
}

export interface ReferenceProvenanceCatalog {
  enabledDimensions: readonly ReferenceProvenanceDimension[];
  agentOptions: readonly ReferenceProvenanceOption[];
  memberOptions: readonly ReferenceProvenanceOption[];
}

export const EMPTY_REFERENCE_PROVENANCE_FILTER: ReferenceProvenanceFilter = {
  agentTargetIds: null,
  memberIds: null
};
