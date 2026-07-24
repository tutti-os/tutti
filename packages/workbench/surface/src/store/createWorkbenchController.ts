import type { WorkbenchState } from "../core/types.ts";
import { createWorkbenchCommands } from "./commands.ts";
import { createWorkbenchStore } from "./createWorkbenchStore.ts";
import type {
  WorkbenchController,
  WorkbenchDebugDiagnostics
} from "./types.ts";

export function createWorkbenchController<TData = unknown>(
  initialState: Partial<WorkbenchState<TData>> = {},
  options: {
    debugDiagnostics?: WorkbenchDebugDiagnostics;
    onSurfaceSizeMeasured?: () => void;
  } = {}
): WorkbenchController<TData> {
  const store = createWorkbenchStore(initialState, options);

  return {
    ...store,
    commands: createWorkbenchCommands(store)
  };
}
