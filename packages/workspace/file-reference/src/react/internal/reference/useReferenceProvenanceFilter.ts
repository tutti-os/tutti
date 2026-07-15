import { useState, useSyncExternalStore } from "react";
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
  catalog: ReferenceProvenanceCatalog
) {
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
  const setDimensionIds = (
    dimension: ReferenceProvenanceDimension,
    ids: readonly string[] | null
  ) => {
    setStoredValue((current) =>
      withReferenceProvenanceFilterIds(
        normalizeReferenceProvenanceFilter(current, catalog),
        dimension,
        ids
      )
    );
  };
  return {
    snapshot: { catalog, value },
    controller: {
      reset: () => setStoredValue(() => EMPTY_REFERENCE_PROVENANCE_FILTER),
      toggle(dimension: ReferenceProvenanceDimension, id: string) {
        const current = referenceProvenanceFilterIds(value, dimension);
        const options =
          dimension === "agent" ? catalog.agentOptions : catalog.memberOptions;
        const next = new Set(
          current ??
            options
              .filter((option) => !option.disabled)
              .map((option) => option.id)
        );
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setDimensionIds(dimension, [...next]);
      },
      toggleAll(dimension: ReferenceProvenanceDimension) {
        setDimensionIds(
          dimension,
          referenceProvenanceFilterIds(value, dimension) === null ? [] : null
        );
      }
    }
  };
}
