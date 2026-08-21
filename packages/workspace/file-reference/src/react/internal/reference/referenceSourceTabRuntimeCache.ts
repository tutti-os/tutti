import type {
  ReferenceSourceAggregator,
  ReferenceSourceTab
} from "../../../core/referenceSourceAggregator.ts";

const tabsByAggregator = new WeakMap<
  ReferenceSourceAggregator,
  Map<string, readonly ReferenceSourceTab[]>
>();

export function readReferenceSourceTabRuntimeCache(
  aggregator: ReferenceSourceAggregator,
  workspaceId: string
): readonly ReferenceSourceTab[] {
  return tabsByAggregator.get(aggregator)?.get(workspaceId) ?? [];
}

export function writeReferenceSourceTabRuntimeCache(
  aggregator: ReferenceSourceAggregator,
  workspaceId: string,
  tabs: readonly ReferenceSourceTab[]
): void {
  let byWorkspace = tabsByAggregator.get(aggregator);
  if (!byWorkspace) {
    byWorkspace = new Map();
    tabsByAggregator.set(aggregator, byWorkspace);
  }
  byWorkspace.set(workspaceId, tabs);
}

export function invalidateReferenceSourceTabRuntimeCache(
  aggregator: ReferenceSourceAggregator,
  workspaceId?: string
): void {
  if (workspaceId === undefined) {
    tabsByAggregator.delete(aggregator);
    return;
  }
  const byWorkspace = tabsByAggregator.get(aggregator);
  byWorkspace?.delete(workspaceId);
  if (byWorkspace?.size === 0) {
    tabsByAggregator.delete(aggregator);
  }
}

/**
 * 权限/Host 能力变化时统一清理可见 Tab 快照并取消关联的在途读取。
 * 二级分组和目录内容属于单次打开状态，不进入这里的跨打开缓存。
 */
export function invalidateReferenceSourcePickerRuntimeCache(
  aggregator: ReferenceSourceAggregator,
  workspaceId?: string
): void {
  invalidateReferenceSourceTabRuntimeCache(aggregator, workspaceId);
  aggregator.invalidateRuntimeReads(
    workspaceId === undefined ? undefined : { workspaceId }
  );
}
