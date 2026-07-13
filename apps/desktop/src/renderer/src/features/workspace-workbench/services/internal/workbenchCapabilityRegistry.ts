import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import type {
  WorkbenchCapabilityFactoryDescriptor,
  WorkbenchProductProfile
} from "./workbenchProductProfile.ts";

export interface WorkbenchCapabilityRegistryResult {
  readonly contributions: readonly WorkbenchContribution[];
}

interface ResolvedWorkbenchCapability {
  readonly contribution: WorkbenchContribution;
  readonly factoryId: string;
}

export function resolveWorkbenchCapabilityRegistry(
  profile: WorkbenchProductProfile
): WorkbenchCapabilityRegistryResult {
  const factories = [...profile.capabilityFactories].sort(
    compareWorkbenchCapabilityFactories
  );
  assertUniqueFactoryIds(factories);

  const resolvedCapabilities = factories.flatMap((factory) => {
    const contribution = factory.create();
    return contribution ? [{ contribution, factoryId: factory.id }] : [];
  });
  assertUniqueContributionOwnership(resolvedCapabilities);

  return {
    contributions: resolvedCapabilities.map(({ contribution }) => contribution)
  };
}

function compareWorkbenchCapabilityFactories(
  left: WorkbenchCapabilityFactoryDescriptor,
  right: WorkbenchCapabilityFactoryDescriptor
): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function assertUniqueFactoryIds(
  factories: readonly WorkbenchCapabilityFactoryDescriptor[]
): void {
  const owners = new Set<string>();
  for (const factory of factories) {
    if (owners.has(factory.id)) {
      throw new Error(
        `Workbench capability factory id "${factory.id}" has multiple owners.`
      );
    }
    owners.add(factory.id);
  }
}

function assertUniqueContributionOwnership(
  resolvedCapabilities: readonly ResolvedWorkbenchCapability[]
): void {
  const contributionOwners = new Map<string, string>();
  const nodeOwners = new Map<string, string>();
  const dockEntryOwners = new Map<string, string>();

  for (const { contribution, factoryId } of resolvedCapabilities) {
    assertUniqueOwner(
      contributionOwners,
      contribution.id,
      factoryId,
      "contribution id"
    );
    for (const node of contribution.nodes ?? []) {
      assertUniqueOwner(
        nodeOwners,
        node.typeId,
        contribution.id,
        "node type id"
      );
    }
    for (const dockEntry of contribution.dockEntries ?? []) {
      assertUniqueOwner(
        dockEntryOwners,
        dockEntry.id,
        contribution.id,
        "dock entry id"
      );
    }
  }
}

function assertUniqueOwner(
  owners: Map<string, string>,
  id: string,
  owner: string,
  kind: string
): void {
  const existingOwner = owners.get(id);
  if (existingOwner) {
    throw new Error(
      `Workbench ${kind} "${id}" is owned by both "${existingOwner}" and "${owner}".`
    );
  }
  owners.set(id, owner);
}
