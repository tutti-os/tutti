import type { WorkbenchContribution } from "@tutti-os/workbench-surface";
import type { WorkbenchScope } from "./workbenchHostSession.ts";

export interface WorkbenchCapabilityFactoryDescriptor {
  readonly id: string;
  readonly order: number;
  readonly create: () => WorkbenchContribution | null;
}

export interface WorkbenchProductProfile {
  readonly productId: string;
  readonly scopeKind: WorkbenchScope["kind"];
  readonly capabilityFactories: readonly WorkbenchCapabilityFactoryDescriptor[];
}
