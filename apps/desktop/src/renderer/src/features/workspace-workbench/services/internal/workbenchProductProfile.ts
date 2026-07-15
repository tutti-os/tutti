import type { WorkbenchCapabilityFactoryDescriptor } from "@tutti-os/workbench-host";
import type { WorkbenchScope } from "./workbenchHostSession.ts";

export type { WorkbenchCapabilityFactoryDescriptor } from "@tutti-os/workbench-host";

export interface WorkbenchProductProfile {
  readonly productId: string;
  readonly scopeKind: WorkbenchScope["kind"];
  readonly capabilityFactories: readonly WorkbenchCapabilityFactoryDescriptor[];
}
