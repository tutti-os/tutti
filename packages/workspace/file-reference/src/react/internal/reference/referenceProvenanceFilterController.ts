import type {
  ReferenceProvenanceCatalog,
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter
} from "../../../contracts/referenceProvenance.ts";
import { EMPTY_REFERENCE_PROVENANCE_FILTER } from "../../../contracts/referenceProvenance.ts";
import {
  normalizeReferenceProvenanceFilter,
  normalizeReferenceProvenanceCatalog,
  toggleAllReferenceProvenanceFilterIds,
  toggleReferenceProvenanceFilterId
} from "../../../core/referenceProvenance.ts";

export interface ReferenceProvenanceFilterSnapshot {
  catalog: ReferenceProvenanceCatalog;
  value: ReferenceProvenanceFilter;
}

export interface ReferenceProvenanceFilterController {
  getSnapshot(): ReferenceProvenanceFilterSnapshot;
  subscribe(listener: () => void): () => void;
  setCatalog(catalog: ReferenceProvenanceCatalog): void;
  setValue(value: ReferenceProvenanceFilter): void;
  toggle(dimension: ReferenceProvenanceDimension, id: string): void;
  toggleAll(dimension: ReferenceProvenanceDimension): void;
  reset(): void;
}

const EMPTY_CATALOG: ReferenceProvenanceCatalog = {
  enabledDimensions: [],
  agentOptions: [],
  memberOptions: []
};

export function createReferenceProvenanceFilterController(
  initialCatalog: ReferenceProvenanceCatalog = EMPTY_CATALOG
): ReferenceProvenanceFilterController {
  const normalizedInitialCatalog =
    normalizeReferenceProvenanceCatalog(initialCatalog);
  let snapshot: ReferenceProvenanceFilterSnapshot = {
    catalog: normalizedInitialCatalog,
    value: normalizeReferenceProvenanceFilter(
      EMPTY_REFERENCE_PROVENANCE_FILTER,
      normalizedInitialCatalog
    )
  };
  const listeners = new Set<() => void>();
  const publish = (next: ReferenceProvenanceFilterSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const setValue = (value: ReferenceProvenanceFilter) => {
    publish({
      ...snapshot,
      value: normalizeReferenceProvenanceFilter(value, snapshot.catalog)
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCatalog(catalog) {
      const normalizedCatalog = normalizeReferenceProvenanceCatalog(catalog);
      publish({
        catalog: normalizedCatalog,
        value: normalizeReferenceProvenanceFilter(
          snapshot.value,
          normalizedCatalog
        )
      });
    },
    setValue(value) {
      setValue(value);
    },
    toggle(dimension, id) {
      setValue(
        toggleReferenceProvenanceFilterId(
          snapshot.value,
          snapshot.catalog,
          dimension,
          id
        )
      );
    },
    toggleAll(dimension) {
      setValue(
        toggleAllReferenceProvenanceFilterIds(
          snapshot.value,
          snapshot.catalog,
          dimension
        )
      );
    },
    reset() {
      setValue(EMPTY_REFERENCE_PROVENANCE_FILTER);
    }
  };
}
