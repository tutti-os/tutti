import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReferenceNode,
  ReferenceScope
} from "../../../contracts/referenceSource.ts";
import type {
  ReferenceSourceAggregator,
  ReferenceSourceTab
} from "../../../core/referenceSourceAggregator.ts";
import {
  appendReferencePage,
  sortReferenceNodes
} from "../../../core/referenceSourceUtils.ts";

const SIDEBAR_GROUP_LOAD_CONCURRENCY = 3;

export interface ReferenceSourceSidebarGroupsState {
  autoSelectFirst: boolean;
  entries: ReferenceNode[];
  error: Error | null;
  loaded: boolean;
  loading: boolean;
  nextCursor: string | null;
}

interface Input {
  aggregator: ReferenceSourceAggregator;
  open: boolean;
  scope: ReferenceScope;
  tabs: readonly ReferenceSourceTab[];
  tabsValidated: boolean;
}

function emptyState(): ReferenceSourceSidebarGroupsState {
  return {
    autoSelectFirst: false,
    entries: [],
    error: null,
    loaded: false,
    loading: false,
    nextCursor: null
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("load reference sidebar groups failed");
}

/**
 * 二级分组只属于当前 Picker 打开周期。
 *
 * 每次 Source Catalog 刷新成功后重新取数；关闭即清空。Aggregator 内的只读
 * Request Coordinator 仍可让多个面板共享同一条正在执行的请求。
 */
export function useReferenceSourceSidebarGroups({
  aggregator,
  open,
  scope,
  tabs,
  tabsValidated
}: Input) {
  const [bySource, setBySource] = useState<
    Record<string, ReferenceSourceSidebarGroupsState>
  >({});
  const stateRef = useRef(bySource);
  stateRef.current = bySource;
  const generationRef = useRef(0);
  const activeControllersRef = useRef(new Set<AbortController>());

  const load = useCallback(
    async (
      sourceId: string,
      append: boolean,
      consumerSignal?: AbortSignal
    ): Promise<void> => {
      const existing = stateRef.current[sourceId] ?? emptyState();
      const cursor = append ? existing.nextCursor : null;
      // 初次读取不能复用上一打开周期的 loading 状态；每次打开都必须重新请求。
      if (append && (existing.loading || !cursor)) return;

      const generation = generationRef.current;
      const localController = new AbortController();
      activeControllersRef.current.add(localController);
      const abort = (): void => localController.abort();
      consumerSignal?.addEventListener("abort", abort, { once: true });
      setBySource((current) => ({
        ...current,
        [sourceId]: {
          ...(current[sourceId] ?? emptyState()),
          error: null,
          loading: true
        }
      }));

      try {
        const result = await aggregator.loadSidebarGroups(scope, sourceId, {
          cursor,
          signal: localController.signal
        });
        if (
          localController.signal.aborted ||
          generation !== generationRef.current
        ) {
          return;
        }
        setBySource((current) => {
          const prior = current[sourceId] ?? emptyState();
          const page = result.ordered
            ? [...result.entries]
            : sortReferenceNodes(result.entries);
          return {
            ...current,
            [sourceId]: {
              autoSelectFirst: result.autoSelectFirst ?? prior.autoSelectFirst,
              entries: append ? appendReferencePage(prior.entries, page) : page,
              error: null,
              loaded: true,
              loading: false,
              nextCursor: result.nextCursor ?? null
            }
          };
        });
      } catch (error) {
        if (
          localController.signal.aborted ||
          generation !== generationRef.current
        ) {
          return;
        }
        setBySource((current) => ({
          ...current,
          [sourceId]: {
            ...(current[sourceId] ?? emptyState()),
            error: normalizeError(error),
            loading: false
          }
        }));
      } finally {
        consumerSignal?.removeEventListener("abort", abort);
        activeControllersRef.current.delete(localController);
      }
    },
    [aggregator, scope]
  );

  const sourceIdsKey = tabs.map((tab) => tab.sourceId).join("\0");
  useEffect(() => {
    generationRef.current += 1;
    for (const controller of activeControllersRef.current) {
      controller.abort();
    }
    activeControllersRef.current.clear();
    setBySource({});

    if (!open || !tabsValidated || tabs.length === 0) return;

    const controller = new AbortController();
    const sourceIds = tabs.map((tab) => tab.sourceId);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const sourceId = sourceIds[nextIndex];
        nextIndex += 1;
        if (!sourceId) return;
        await load(sourceId, false, controller.signal);
      }
    };
    void Promise.all(
      Array.from(
        {
          length: Math.min(SIDEBAR_GROUP_LOAD_CONCURRENCY, sourceIds.length)
        },
        () => worker()
      )
    );
    return () => controller.abort();
  }, [load, open, sourceIdsKey, tabsValidated]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      for (const controller of activeControllersRef.current) {
        controller.abort();
      }
      activeControllersRef.current.clear();
    },
    []
  );

  return {
    bySource,
    loadMore(sourceId: string): void {
      void load(sourceId, true);
    }
  };
}
