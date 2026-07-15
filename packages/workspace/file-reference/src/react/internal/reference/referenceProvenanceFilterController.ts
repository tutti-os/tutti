import type {
  ReferenceProvenanceCatalog,
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter
} from "../../../contracts/referenceProvenance.ts";
import { EMPTY_REFERENCE_PROVENANCE_FILTER } from "../../../contracts/referenceProvenance.ts";
import {
  normalizeReferenceProvenanceFilter,
  referenceProvenanceFilterIds,
  withReferenceProvenanceFilterIds
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
  let snapshot: ReferenceProvenanceFilterSnapshot = {
    catalog: initialCatalog,
    value: normalizeReferenceProvenanceFilter(
      EMPTY_REFERENCE_PROVENANCE_FILTER,
      initialCatalog
    )
  };
  const listeners = new Set<() => void>();
  const publish = (next: ReferenceProvenanceFilterSnapshot) => {
    if (snapshot === next) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const optionsFor = (dimension: ReferenceProvenanceDimension) =>
    dimension === "agent"
      ? snapshot.catalog.agentOptions
      : snapshot.catalog.memberOptions;
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
      publish({
        catalog,
        value: normalizeReferenceProvenanceFilter(snapshot.value, catalog)
      });
    },
    setValue(value) {
      setValue(value);
    },
    toggle(dimension, id) {
      const current = referenceProvenanceFilterIds(snapshot.value, dimension);
      const allIds = optionsFor(dimension)
        .filter((option) => !option.disabled)
        .map((option) => option.id);
      const next = new Set(current ?? allIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setValue(
        withReferenceProvenanceFilterIds(snapshot.value, dimension, [...next])
      );
    },
    toggleAll(dimension) {
      const current = referenceProvenanceFilterIds(snapshot.value, dimension);
      setValue(
        withReferenceProvenanceFilterIds(
          snapshot.value,
          dimension,
          current === null ? [] : null
        )
      );
    },
    reset() {
      setValue(EMPTY_REFERENCE_PROVENANCE_FILTER);
    }
  };
}
