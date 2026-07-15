import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";

import type { WorkbenchCapabilityRegistryInput } from "../capabilities/workbenchCapabilityRegistry.ts";
import { resolveWorkbenchCapabilityRegistry } from "../capabilities/workbenchCapabilityRegistry.ts";
import {
  createWorkbenchHostSessionConfiguration,
  WorkbenchHostCoordinator
} from "../coordinator/workbenchHostCoordinator.ts";
import {
  WorkbenchHostSession,
  type WorkbenchHostSessionResolution,
  type WorkbenchSnapshotPartition
} from "../session/workbenchHostSession.ts";

export interface WorkbenchHostConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

export interface WorkbenchHostConformancePartitionInput {
  readonly principalId?: string;
  readonly scopeId: string;
}

export interface WorkbenchHostConformanceOptions {
  readonly capabilityProfile?: WorkbenchCapabilityRegistryInput;
  readonly createCoordinator?: () => WorkbenchHostCoordinator;
  readonly createPartition?: (
    input: WorkbenchHostConformancePartitionInput
  ) => WorkbenchSnapshotPartition;
  readonly expectedContributionIds?: readonly string[];
}

interface FixtureUpdate {
  readonly reuseCurrent?: boolean;
  readonly value: string;
}

interface FixtureHostInput {
  readonly value: string;
}

export function createWorkbenchHostConformanceCases(
  options: WorkbenchHostConformanceOptions = {}
): readonly WorkbenchHostConformanceCase[] {
  const createCoordinator =
    options.createCoordinator ?? (() => new WorkbenchHostCoordinator());
  const createPartition = options.createPartition ?? createDefaultPartition;
  const capabilityProfile =
    options.capabilityProfile ?? createDefaultCapabilityProfile();
  const expectedContributionIds = options.expectedContributionIds ?? [
    "capability-a",
    "capability-b"
  ];

  if (
    options.capabilityProfile &&
    options.expectedContributionIds === undefined
  ) {
    throw new Error(
      "Workbench host conformance requires expected contribution ids for a custom capability profile."
    );
  }

  return [
    {
      name: "reuses one live session for repeated opens in one coordinator",
      run: () => {
        const coordinator = createCoordinator();
        let disposeCount = 0;
        const configuration = createFixtureConfiguration(() => {
          disposeCount += 1;
        });
        const partition = createPartition({ scopeId: "scope-a" });
        const firstLease = coordinator.open({ configuration, partition });
        const secondLease = coordinator.open({ configuration, partition });

        assertSame(firstLease.session, secondLease.session, "session reuse");
        firstLease.release();
        assertFalse(firstLease.session.isDisposed, "first lease release");
        secondLease.release();
        assertTrue(firstLease.session.isDisposed, "last lease release");
        assertEqual(disposeCount, 1, "session disposal count");
        coordinator.dispose();
        assertEqual(disposeCount, 1, "coordinator idempotent disposal");
      }
    },
    {
      name: "keeps the same partition isolated across renderer coordinators",
      run: () => {
        const firstCoordinator = createCoordinator();
        const secondCoordinator = createCoordinator();
        const configuration = createFixtureConfiguration();
        const partition = createPartition({ scopeId: "scope-a" });
        const firstLease = firstCoordinator.open({ configuration, partition });
        const secondLease = secondCoordinator.open({
          configuration,
          partition
        });

        assertNotSame(
          firstLease.session,
          secondLease.session,
          "renderer-local sessions"
        );
        firstLease.release();
        secondLease.release();
        firstCoordinator.dispose();
        secondCoordinator.dispose();
      }
    },
    {
      name: "keeps concurrent distinct scope partitions independent",
      run: () => {
        const coordinator = createCoordinator();
        const configuration = createFixtureConfiguration();
        const firstLease = coordinator.open({
          configuration,
          partition: createPartition({ scopeId: "scope-a" })
        });
        const secondLease = coordinator.open({
          configuration,
          partition: createPartition({ scopeId: "scope-b" })
        });

        assertNotSame(
          firstLease.session,
          secondLease.session,
          "scope sessions"
        );
        firstLease.release();
        assertFalse(
          secondLease.session.isDisposed,
          "independent scope session"
        );
        secondLease.release();
        coordinator.dispose();
      }
    },
    {
      name: "replaces a scope session when its principal partition changes",
      run: () => {
        const coordinator = createCoordinator();
        const configuration = createFixtureConfiguration();
        const firstLease = coordinator.open({
          configuration,
          partition: createPartition({
            principalId: "principal-a",
            scopeId: "scope-a"
          })
        });
        const replacementLease = coordinator.open({
          configuration,
          partition: createPartition({
            principalId: "principal-b",
            scopeId: "scope-a"
          })
        });

        assertTrue(firstLease.session.isDisposed, "replaced session disposal");
        assertNotSame(
          firstLease.session,
          replacementLease.session,
          "principal replacement"
        );
        firstLease.release();
        replacementLease.release();
        coordinator.dispose();
      }
    },
    {
      name: "preserves replacement surface ownership across stale detach",
      run: () => {
        const coordinator = createCoordinator();
        const configuration = createFixtureConfiguration();
        const lease = coordinator.open({
          configuration,
          partition: createPartition({ scopeId: "scope-a" })
        });
        const firstHandle = {} as WorkbenchHostHandle;
        const replacementHandle = {} as WorkbenchHostHandle;
        const firstOwner = {};
        const replacementOwner = {};

        lease.session.attachSurface(firstHandle, firstOwner);
        lease.session.attachSurface(replacementHandle, replacementOwner);
        lease.session.attachSurface(null, firstOwner);
        assertSame(
          lease.session.getAttachedSurface(),
          replacementHandle,
          "stale surface detach"
        );
        lease.session.attachSurface(null, replacementOwner);
        assertEqual(
          lease.session.getAttachedSurface(),
          null,
          "replacement surface detach"
        );
        lease.release();
        coordinator.dispose();
      }
    },
    {
      name: "publishes stable host input and rejects work after disposal",
      run: () => {
        const coordinator = createCoordinator();
        const configuration = createFixtureConfiguration();
        const lease = coordinator.open({
          configuration,
          partition: createPartition({ scopeId: "scope-a" })
        });
        let publicationCount = 0;
        lease.session.subscribe(() => {
          publicationCount += 1;
        });

        const first = lease.session.update({ value: "first" });
        const reused = lease.session.update({
          reuseCurrent: true,
          value: "ignored"
        });
        const second = lease.session.update({ value: "second" });

        assertSame(first, reused, "stable host input identity");
        assertNotSame(first, second, "changed host input identity");
        assertEqual(publicationCount, 2, "host input publications");
        lease.release();
        assertThrows(
          () => lease.session.update({ value: "late" }),
          "disposed",
          "late update"
        );
        assertThrows(
          () => lease.session.attachSurface({} as WorkbenchHostHandle, {}),
          "disposed",
          "late surface attachment"
        );
        coordinator.dispose();
      }
    },
    {
      name: "resolves capability ownership in deterministic order",
      run: () => {
        const result = resolveWorkbenchCapabilityRegistry(capabilityProfile);
        assertArrayEqual(
          result.contributions.map(({ id }) => id),
          expectedContributionIds,
          "contribution order"
        );
      }
    },
    {
      name: "rejects duplicate capability ownership before publication",
      run: () => {
        assertThrows(
          () =>
            resolveWorkbenchCapabilityRegistry({
              capabilityFactories: [
                createCapabilityFactory("factory-a", 10, "duplicate"),
                createCapabilityFactory("factory-b", 20, "duplicate")
              ]
            }),
          "owned by both",
          "duplicate contribution ownership"
        );
      }
    }
  ];
}

function createDefaultPartition(
  input: WorkbenchHostConformancePartitionInput
): WorkbenchSnapshotPartition {
  return {
    ...(input.principalId ? { principal: { id: input.principalId } } : {}),
    scope: { id: input.scopeId, kind: "workspace" }
  };
}

function createDefaultCapabilityProfile(): WorkbenchCapabilityRegistryInput {
  return {
    capabilityFactories: [
      createCapabilityFactory("factory-b", 20, "capability-b"),
      createCapabilityFactory("factory-a", 10, "capability-a"),
      {
        create: () => null,
        id: "unavailable",
        order: 0
      }
    ]
  };
}

function createCapabilityFactory(
  id: string,
  order: number,
  contributionId: string
) {
  return {
    create: (): WorkbenchContribution => ({ id: contributionId }),
    id,
    order
  };
}

function createFixtureConfiguration(onDispose: () => void = noop) {
  return createWorkbenchHostSessionConfiguration<
    FixtureUpdate,
    FixtureHostInput,
    string
  >({
    createSession: (partition) => {
      const session = new WorkbenchHostSession<
        FixtureUpdate,
        FixtureHostInput,
        string
      >({
        partition,
        resolve: resolveFixtureHostInput
      });
      session.registerDisposable(onDispose);
      return session;
    }
  });
}

function resolveFixtureHostInput(
  update: FixtureUpdate,
  current: WorkbenchHostSessionResolution<FixtureHostInput, string> | null
): WorkbenchHostSessionResolution<FixtureHostInput, string> {
  if (update.reuseCurrent && current) {
    return current;
  }
  return {
    hostInput: { value: update.value },
    state: update.value
  };
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: values are not equal`);
  }
}

function assertFalse(value: boolean, label: string): void {
  assertEqual(value, false, label);
}

function assertNotSame<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    throw new Error(`${label}: values unexpectedly share identity`);
  }
}

function assertSame<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: values do not share identity`);
  }
}

function assertThrows(
  run: () => void,
  expectedMessage: string,
  label: string
): void {
  try {
    run();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes(expectedMessage.toLowerCase())
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${label}: expected an error containing ${expectedMessage}`);
}

function assertTrue(value: boolean, label: string): void {
  assertEqual(value, true, label);
}

function noop(): void {}
