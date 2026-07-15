import { createDecorator } from "@tutti-os/infra/di";
import type { WorkbenchHostCoordinator } from "@tutti-os/workbench-host";

export const IWorkbenchHostCoordinator =
  createDecorator<WorkbenchHostCoordinator>("workbench-host-coordinator");
