import type {
  WorkspaceWorkbenchHostInput,
  WorkspaceWorkbenchHostSessionBinding,
  WorkspaceWorkbenchHostSessionUpdate
} from "../workspaceWorkbenchHostService.interface.ts";
import type { WorkbenchHostSessionLease } from "./workbenchHostCoordinator.ts";

export function createWorkspaceWorkbenchHostSessionBinding<TState>(input: {
  bindingId: number;
  lease: WorkbenchHostSessionLease<
    WorkspaceWorkbenchHostSessionUpdate,
    WorkspaceWorkbenchHostInput,
    TState
  >;
  workspaceId: string;
}): WorkspaceWorkbenchHostSessionBinding {
  let active = true;
  return {
    bindingId: input.bindingId,
    get isActive() {
      return active;
    },
    workspaceId: input.workspaceId,
    attachSurface(handle) {
      if (!active) {
        return;
      }
      input.lease.session.attachSurface(handle);
    },
    createHostInput(update) {
      if (!active) {
        throw new Error(
          "Workspace Workbench host session binding is released."
        );
      }
      if (update.workspaceId !== input.workspaceId) {
        throw new Error(
          "Workspace Workbench host session update does not match its binding."
        );
      }
      return input.lease.session.update(update);
    },
    release() {
      if (!active) {
        return;
      }
      active = false;
      input.lease.release();
    },
    subscribe(listener) {
      if (!active) {
        return noop;
      }
      return input.lease.session.subscribe(listener);
    }
  };
}

function noop(): void {}
