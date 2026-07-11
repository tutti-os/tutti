import { createDecorator } from "@tutti-os/infra/di";
import type { WorkbenchHostCoordinator } from "./internal/workbenchHostCoordinator.ts";

export const IWorkbenchHostCoordinator =
  createDecorator<WorkbenchHostCoordinator>("workbench-host-coordinator");
