import { createDecorator } from "@tutti-os/infra/di";
import type { AppUpdateReadableStoreState } from "./appUpdateTypes";

export interface IAppUpdateService {
  readonly _serviceBrand: undefined;
  readonly store: AppUpdateReadableStoreState;

  load(): Promise<void>;
  checkForUpdates(): Promise<void>;
  runPrimaryAction(): Promise<void>;
}

export const IAppUpdateService =
  createDecorator<IAppUpdateService>("app-update-service");
