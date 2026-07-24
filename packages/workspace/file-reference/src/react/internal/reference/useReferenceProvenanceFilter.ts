import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
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
  const catalog = useMemo(
    () => normalizeReferenceProvenanceCatalog(injectedCatalog),
    [injectedCatalog]
  );
  const catalogKey = useMemo(
    () => [...catalog.enabledDimensions].sort().join("|"),
    [catalog]
  );
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
  const setStoredValue = useCallback(
    (
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
    },
    [catalogKey]
  );
  const value = useMemo(
    () => normalizeReferenceProvenanceFilter(storedValue, catalog),
    [catalog, storedValue]
  );
  const reset = useCallback(
    () => setStoredValue(() => EMPTY_REFERENCE_PROVENANCE_FILTER),
    [setStoredValue]
  );
  const toggle = useCallback(
    (dimension: ReferenceProvenanceDimension, id: string) => {
      setStoredValue((current) =>
        toggleReferenceProvenanceFilterId(current, catalog, dimension, id)
      );
    },
    [catalog, setStoredValue]
  );
  const toggleAll = useCallback(
    (dimension: ReferenceProvenanceDimension) => {
      setStoredValue((current) =>
        toggleAllReferenceProvenanceFilterIds(current, catalog, dimension)
      );
    },
    [catalog, setStoredValue]
  );
  const snapshot = useMemo(() => ({ catalog, value }), [catalog, value]);
  const controller = useMemo(
    () => ({ reset, toggle, toggleAll }),
    [reset, toggle, toggleAll]
  );
  return useMemo(() => ({ snapshot, controller }), [controller, snapshot]);
}
