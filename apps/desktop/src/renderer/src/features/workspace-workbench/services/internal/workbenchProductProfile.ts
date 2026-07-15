import type {
  WorkbenchCapabilityFactoryDescriptor,
  WorkbenchScope
} from "@tutti-os/workbench-host";

export interface WorkbenchProductProfile {
  readonly productId: string;
  readonly scopeKind: WorkbenchScope["kind"];
  readonly capabilityFactories: readonly WorkbenchCapabilityFactoryDescriptor[];
}
