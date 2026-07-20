import type {
  WorkbenchContribution,
  WorkbenchHostDockEntry,
  WorkbenchHostExternalStateSource,
  WorkbenchHostClosePreparer,
  WorkbenchHostLaunchRequest,
  WorkbenchHostNodeCloseRequest,
  WorkbenchHostNodeDefinition,
  WorkbenchHostProps
} from "./types.ts";

export interface ResolvedWorkbenchHostConfig {
  dockEntries: readonly WorkbenchHostDockEntry[];
  externalStateSource?: WorkbenchHostExternalStateSource;
  nodes: readonly WorkbenchHostNodeDefinition[];
  onLaunchRequest?: WorkbenchHostProps["onLaunchRequest"];
  onNodeCloseRequest?: WorkbenchHostProps["onNodeCloseRequest"];
  prepareHostClose?: WorkbenchHostClosePreparer;
}

export interface ResolvedWorkbenchHostRuntimeConfig {
  externalStateSource?: WorkbenchHostExternalStateSource;
  nodes: readonly WorkbenchHostNodeDefinition[];
  onLaunchRequest?: WorkbenchHostProps["onLaunchRequest"];
  onNodeCloseRequest?: WorkbenchHostProps["onNodeCloseRequest"];
}

export function resolveWorkbenchHostConfig(
  props: Pick<
    WorkbenchHostProps,
    | "contributions"
    | "dockEntryPresentationOverrides"
    | "dockEntries"
    | "externalStateSource"
    | "nodes"
    | "onLaunchRequest"
    | "onNodeCloseRequest"
  >
): ResolvedWorkbenchHostConfig {
  const contributions = props.contributions ?? [];

  return {
    dockEntries: resolveWorkbenchHostDockEntries(props),
    ...resolveWorkbenchHostRuntimeConfig(props),
    prepareHostClose: resolveHostClosePreparer(contributions)
  };
}

export function resolveWorkbenchHostDockEntries(
  props: Pick<
    WorkbenchHostProps,
    "contributions" | "dockEntryPresentationOverrides" | "dockEntries"
  >
): readonly WorkbenchHostDockEntry[] {
  const contributions = props.contributions ?? [];
  const mergedEntries = mergeByKey(
    contributions.flatMap((contribution) => contribution.dockEntries ?? []),
    props.dockEntries ?? [],
    (entry) => entry.id
  );
  const presentationOverrides = props.dockEntryPresentationOverrides;
  if (!presentationOverrides) {
    return mergedEntries;
  }
  return mergedEntries.map((entry) => {
    const presentationOverride = presentationOverrides[entry.id];
    return presentationOverride ? { ...entry, ...presentationOverride } : entry;
  });
}

export function resolveWorkbenchHostRuntimeConfig(
  props: Pick<
    WorkbenchHostProps,
    | "contributions"
    | "externalStateSource"
    | "nodes"
    | "onLaunchRequest"
    | "onNodeCloseRequest"
  >
): ResolvedWorkbenchHostRuntimeConfig {
  const contributions = props.contributions ?? [];

  return {
    externalStateSource:
      props.externalStateSource ??
      combineContributionExternalStateSources(contributions),
    nodes: mergeByKey(
      contributions.flatMap((contribution) => contribution.nodes ?? []),
      props.nodes ?? [],
      (definition) => definition.typeId
    ),
    onLaunchRequest: resolveLaunchRequestHandler({
      contributions,
      explicitHandler: props.onLaunchRequest
    }),
    onNodeCloseRequest: resolveNodeCloseRequestHandler({
      contributions,
      explicitHandler: props.onNodeCloseRequest
    })
  };
}

function mergeByKey<T>(
  contributionItems: readonly T[],
  explicitItems: readonly T[],
  getKey: (item: T) => string
): readonly T[] {
  const merged = new Map<string, T>();
  for (const item of [...contributionItems, ...explicitItems]) {
    const key = getKey(item);
    merged.delete(key);
    merged.set(key, item);
  }
  return [...merged.values()];
}

function combineContributionExternalStateSources(
  contributions: readonly WorkbenchContribution[]
): WorkbenchHostExternalStateSource | undefined {
  const sources = contributions
    .map((contribution) => contribution.externalStateSource)
    .filter((source): source is WorkbenchHostExternalStateSource =>
      Boolean(source)
    );

  if (sources.length === 0) {
    return undefined;
  }

  return {
    getNodeState(input) {
      for (const source of sources) {
        const state = source.getNodeState(input);
        if (state !== null && state !== undefined) {
          return state;
        }
      }
      return null;
    },
    getSnapshotNodeState(input) {
      for (const source of sources) {
        const state = source.getSnapshotNodeState?.(input);
        if (state !== null && state !== undefined) {
          return state;
        }
      }
      return null;
    },
    getWorkspaceState(input) {
      for (const source of sources) {
        const state = source.getWorkspaceState(input);
        if (state !== null && state !== undefined) {
          return state;
        }
      }
      return null;
    },
    subscribe(listener) {
      const disposers = sources
        .map((source) => source.subscribe?.(listener))
        .filter((dispose): dispose is () => void => Boolean(dispose));
      return () => {
        for (const dispose of disposers) {
          dispose();
        }
      };
    }
  };
}

function resolveLaunchRequestHandler(input: {
  contributions: readonly WorkbenchContribution[];
  explicitHandler?: WorkbenchHostProps["onLaunchRequest"];
}): WorkbenchHostProps["onLaunchRequest"] {
  const contributionHandlers = input.contributions
    .map((contribution) => contribution.onLaunchRequest)
    .filter(
      (
        handler
      ): handler is NonNullable<WorkbenchContribution["onLaunchRequest"]> =>
        Boolean(handler)
    );

  if (!input.explicitHandler && contributionHandlers.length === 0) {
    return undefined;
  }

  return async (request: WorkbenchHostLaunchRequest) => {
    const explicitResult = await input.explicitHandler?.(request);
    if (explicitResult !== null && explicitResult !== undefined) {
      return explicitResult;
    }

    for (const handler of contributionHandlers) {
      const result = await handler(request);
      if (result !== null && result !== undefined) {
        return result;
      }
    }

    return null;
  };
}

function resolveNodeCloseRequestHandler(input: {
  contributions: readonly WorkbenchContribution[];
  explicitHandler?: WorkbenchHostProps["onNodeCloseRequest"];
}): WorkbenchHostProps["onNodeCloseRequest"] {
  const contributionHandlers = input.contributions
    .map((contribution) => contribution.onNodeCloseRequest)
    .filter(
      (
        handler
      ): handler is NonNullable<WorkbenchContribution["onNodeCloseRequest"]> =>
        Boolean(handler)
    );

  if (!input.explicitHandler && contributionHandlers.length === 0) {
    return undefined;
  }

  return async (request: WorkbenchHostNodeCloseRequest) => {
    const explicitResult = await input.explicitHandler?.(request);
    if (explicitResult !== undefined) {
      return explicitResult;
    }

    for (const handler of contributionHandlers) {
      const result = await handler(request);
      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  };
}

export function resolveWorkbenchHostPrepareClose(
  contributions: readonly WorkbenchContribution[]
): WorkbenchHostClosePreparer | undefined {
  return resolveHostClosePreparer(contributions);
}

function resolveHostClosePreparer(
  contributions: readonly WorkbenchContribution[]
): WorkbenchHostClosePreparer | undefined {
  const preparers = contributions
    .map((contribution) => contribution.prepareHostClose)
    .filter(
      (
        prepare
      ): prepare is NonNullable<WorkbenchContribution["prepareHostClose"]> =>
        Boolean(prepare)
    );

  if (preparers.length === 0) {
    return undefined;
  }

  return async (context) => {
    for (const prepare of preparers) {
      if (!(await prepare(context))) {
        return false;
      }
    }

    return true;
  };
}
