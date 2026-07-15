import { useState, useSyncExternalStore } from "react";
import type {
  ReferenceProvenanceCatalog,
  ReferenceProvenanceDimension,
  ReferenceProvenanceFilter
} from "../../../contracts/referenceProvenance.ts";
import { EMPTY_REFERENCE_PROVENANCE_FILTER } from "../../../contracts/referenceProvenance.ts";
import {
  normalizeReferenceProvenanceCatalog,
  normalizeReferenceProvenanceFilter,
  toggleAllReferenceProvenanceFilterIds,
  toggleReferenceProvenanceFilterId
} from "../../../core/referenceProvenance.ts";
import type { ReferenceProvenanceFilterController } from "./referenceProvenanceFilterController.ts";

export function useReferenceProvenanceFilter(
  controller: ReferenceProvenanceFilterController
) {
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
}

export function useReferenceProvenanceFilterCatalog(
  injectedCatalog: ReferenceProvenanceCatalog
) {
  const catalog = normalizeReferenceProvenanceCatalog(injectedCatalog);
  const catalogKey = [...catalog.enabledDimensions].sort().join("|");
  const [stored, setStored] = useState<{
    catalogKey: string;
    value: ReferenceProvenanceFilter;
  }>(() => ({ catalogKey, value: EMPTY_REFERENCE_PROVENANCE_FILTER }));
  const effectiveStored =
    stored.catalogKey === catalogKey
      ? stored
      : { catalogKey, value: EMPTY_REFERENCE_PROVENANCE_FILTER };
  if (effectiveStored !== stored) setStored(effectiveStored);
  const storedValue = effectiveStored.value;
  const setStoredValue = (
    update: (current: ReferenceProvenanceFilter) => ReferenceProvenanceFilter
  ) => {
    setStored((current) => ({
      catalogKey,
      value: update(
        current.catalogKey === catalogKey
          ? current.value
          : EMPTY_REFERENCE_PROVENANCE_FILTER
      )
    }));
  };
  const value = normalizeReferenceProvenanceFilter(storedValue, catalog);
  return {
    snapshot: { catalog, value },
    controller: {
      reset: () => setStoredValue(() => EMPTY_REFERENCE_PROVENANCE_FILTER),
      toggle(dimension: ReferenceProvenanceDimension, id: string) {
        setStoredValue((current) =>
          toggleReferenceProvenanceFilterId(current, catalog, dimension, id)
        );
      },
      toggleAll(dimension: ReferenceProvenanceDimension) {
        setStoredValue((current) =>
          toggleAllReferenceProvenanceFilterIds(current, catalog, dimension)
        );
      }
    }
  };
}
