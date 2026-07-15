import type { WorkbenchHostSessionLease } from "@tutti-os/workbench-host";
import type {
  WorkspaceWorkbenchHostInput,
  WorkspaceWorkbenchHostSessionBinding,
  WorkspaceWorkbenchHostSessionUpdate
} from "../workspaceWorkbenchHostService.interface.ts";

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
  const subscriptions = new Set<() => void>();
  const surfaceOwner = {};
  return {
    bindingId: input.bindingId,
    get isActive() {
      return active && !input.lease.session.isDisposed;
    },
    workspaceId: input.workspaceId,
    attachSurface(handle) {
      if (!active || input.lease.session.isDisposed) {
        return;
      }
      input.lease.session.attachSurface(handle, surfaceOwner);
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
      const disposeSubscriptions = Array.from(subscriptions);
      subscriptions.clear();
      for (const dispose of disposeSubscriptions) {
        try {
          dispose();
        } catch {
          // Releasing the lease must continue after subscription cleanup fails.
        }
      }
      try {
        if (!input.lease.session.isDisposed) {
          input.lease.session.attachSurface(null, surfaceOwner);
        }
      } finally {
        input.lease.release();
      }
    },
    subscribe(listener) {
      if (!active || input.lease.session.isDisposed) {
        return noop;
      }
      const disposeSessionSubscription =
        input.lease.session.subscribe(listener);
      let subscribed = true;
      const dispose = () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        subscriptions.delete(dispose);
        disposeSessionSubscription();
      };
      subscriptions.add(dispose);
      return dispose;
    }
  };
}

function noop(): void {}
