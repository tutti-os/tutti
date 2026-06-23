import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import type {
  IWorkspaceWorkbenchHostService,
  WorkspaceWorkbenchHostInput
} from "../workspaceWorkbenchHostService.interface";
import { createWorkspaceWindowCloseRequestController } from "./workspaceWindowCloseRequestController.ts";

test("workspace window close request controller sends the latest host and input", async () => {
  const calls: WorkspaceWindowCloseRequestCall[] = [];
  const firstHost = createHost("host-1");
  const secondHost = createHost("host-2");
  const firstHostInput = createHostInput("workspace-1");
  const secondHostInput = createHostInput("workspace-2");
  const firstGuard = async () => false;
  const secondGuard = async () => true;
  const controller = createWorkspaceWindowCloseRequestController({
    confirmCloseGuard: firstGuard,
    hostInput: firstHostInput,
    requestWindowClose: async (input) => {
      calls.push(input);
      return "approved";
    }
  });

  controller.setHost(firstHost);
  await controller.requestClose({ reason: "window-close" });

  controller.update({
    confirmCloseGuard: secondGuard,
    hostInput: secondHostInput,
    requestWindowClose: async (input) => {
      calls.push(input);
      return "approved";
    }
  });
  controller.setHost(secondHost);
  await controller.requestClose({ reason: "quit" });

  assert.equal(calls[0]?.host, firstHost);
  assert.equal(calls[0]?.hostInput, firstHostInput);
  assert.equal(
    await calls[0]?.confirmCloseGuard(createCloseDialogRequest()),
    false
  );
  assert.equal(calls[0]?.reason, "window-close");
  assert.equal(calls[1]?.host, secondHost);
  assert.equal(calls[1]?.hostInput, secondHostInput);
  assert.equal(
    await calls[1]?.confirmCloseGuard(createCloseDialogRequest()),
    true
  );
  assert.equal(calls[1]?.reason, "quit");
});

test("workspace window close request controller supports a missing host", async () => {
  let requestedHost: WorkbenchHostHandle | null | undefined;
  const controller = createWorkspaceWindowCloseRequestController({
    confirmCloseGuard: async () => true,
    hostInput: createHostInput("workspace-1"),
    requestWindowClose: async (input) => {
      requestedHost = input.host;
      return "approved";
    }
  });

  await controller.requestClose({ reason: "window-close" });

  assert.equal(requestedHost, null);
});

type WorkspaceWindowCloseRequestCall = Parameters<
  IWorkspaceWorkbenchHostService["requestWindowClose"]
>[0];

function createHost(id: string): WorkbenchHostHandle {
  return {
    activateNode() {
      return undefined;
    },
    closeNode() {
      return undefined;
    },
    collectWindowCloseEffects: async () => [],
    dispose() {
      return undefined;
    },
    exitFullscreenNode() {
      return undefined;
    },
    focusNode() {
      return undefined;
    },
    getSnapshot() {
      return { id } as never;
    },
    launchNode: async () => null,
    load: async () => undefined,
    minimizeNode() {
      return undefined;
    },
    reconcileProjectedNodes() {
      return undefined;
    },
    requestNodeClose() {
      return undefined;
    },
    setNodeRuntimeState() {
      return undefined;
    },
    setNodeSizeConstraints() {
      return undefined;
    },
    setSnapshotNodeState() {
      return undefined;
    },
    setNodeTitle() {
      return undefined;
    }
  };
}

function createHostInput(workspaceId: string): WorkspaceWorkbenchHostInput {
  return {
    snapshotRepository: {} as never,
    workspaceId
  };
}

function createCloseDialogRequest() {
  return {
    cancelLabel: "Cancel",
    confirmLabel: "Close",
    description: "There is work running.",
    scope: "window" as const,
    title: "Close window?"
  };
}
