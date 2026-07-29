import type { IpcMain, IpcMainEvent } from "electron";
import type {
  BrowserNodeAutomationTargetRequest,
  BrowserNodeAutomationTargetSummary
} from "@tutti-os/browser-node/electron-main";
import {
  desktopIpcChannels,
  type DesktopBrowserAutomationHostReady,
  type DesktopBrowserAutomationRequest,
  type DesktopBrowserAutomationResponse
} from "../../shared/contracts/ipc.ts";

const requestTimeoutMs = 10_000;

interface PendingRequest {
  reject(error: Error): void;
  request: Omit<DesktopBrowserAutomationRequest, "requestId">;
  resolve(nodeId: string | null): void;
  senderId: number;
  timeout: ReturnType<typeof setTimeout>;
}

export interface DesktopBrowserAutomationCoordinator {
  closeTarget(target: BrowserNodeAutomationTargetSummary): Promise<void>;
  dispose(): void;
  requestTarget(
    input: BrowserNodeAutomationTargetRequest
  ): Promise<string | null>;
  selectTarget(target: BrowserNodeAutomationTargetSummary): Promise<void>;
}

export interface DesktopBrowserAutomationCoordinatorOptions {
  ensureAgentBrowserHost(input: {
    agentSessionId: string;
    workspaceId: string;
  }): Promise<void>;
  runtime: {
    ipc: Pick<IpcMain, "off" | "on">;
    randomId(): string;
    resolveHostContext(sender: Electron.WebContents): {
      kind: "agent" | "workspace";
      workspaceId: string;
    } | null;
    resolveWebContents(id: number): Electron.WebContents | null;
  };
}

export function createDesktopBrowserAutomationCoordinator(
  options: DesktopBrowserAutomationCoordinatorOptions
): DesktopBrowserAutomationCoordinator {
  const runtime = options.runtime;
  const pending = new Map<string, PendingRequest>();
  const readyHostIds = new Map<string, Set<number>>();
  const readyWaiters = new Map<string, Set<() => void>>();
  const targetOwnerIds = new Map<string, number>();

  const handleHostReady = (
    event: IpcMainEvent,
    input: DesktopBrowserAutomationHostReady
  ): void => {
    if (
      (input?.surfaceRole !== "agent" && input?.surfaceRole !== "user") ||
      !input.workspaceId?.trim()
    ) {
      return;
    }
    const hostContext = runtime.resolveHostContext(event.sender);
    const expectedKind = input?.surfaceRole === "agent" ? "agent" : "workspace";
    if (
      !hostContext ||
      hostContext.kind !== expectedKind ||
      hostContext.workspaceId !== input?.workspaceId
    ) {
      return;
    }
    const key = hostKey(input.workspaceId, input.surfaceRole);
    const hostIds = readyHostIds.get(key) ?? new Set<number>();
    hostIds.add(event.sender.id);
    readyHostIds.set(key, hostIds);
    for (const resolve of readyWaiters.get(key) ?? []) resolve();
    readyWaiters.delete(key);
  };

  const handleResponse = (
    event: IpcMainEvent,
    response: DesktopBrowserAutomationResponse
  ): void => {
    const request = pending.get(response?.requestId);
    if (!request || request.senderId !== event.sender.id) return;
    pending.delete(response.requestId);
    clearTimeout(request.timeout);
    if (!response.ok) {
      request.reject(new Error(response.error));
      return;
    }
    if (request.request.action === "create" && response.nodeId) {
      targetOwnerIds.set(
        targetKey(request.request.workspaceId, response.nodeId),
        event.sender.id
      );
    } else if (request.request.action === "close" && request.request.nodeId) {
      targetOwnerIds.delete(
        targetKey(request.request.workspaceId, request.request.nodeId)
      );
    }
    request.resolve(response.nodeId);
  };
  runtime.ipc.on(
    desktopIpcChannels.browser.automationHostReady,
    handleHostReady
  );
  runtime.ipc.on(desktopIpcChannels.browser.automationResponse, handleResponse);

  const sendToHost = (
    senderId: number,
    request: Omit<DesktopBrowserAutomationRequest, "requestId">
  ): Promise<string | null> => {
    const sender = runtime.resolveWebContents(senderId);
    if (!sender || sender.isDestroyed()) {
      removeReadyHost(readyHostIds, senderId);
      return Promise.reject(new Error("In-app Browser surface host closed"));
    }
    const requestId = runtime.randomId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("In-app Browser surface request timed out"));
      }, requestTimeoutMs);
      pending.set(requestId, {
        reject,
        request,
        resolve,
        senderId,
        timeout
      });
      try {
        sender.send(desktopIpcChannels.browser.automationRequest, {
          ...request,
          requestId
        } satisfies DesktopBrowserAutomationRequest);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const send = async (
    request: Omit<DesktopBrowserAutomationRequest, "requestId">
  ): Promise<string | null> => {
    const mappedOwnerId = request.nodeId
      ? targetOwnerIds.get(targetKey(request.workspaceId, request.nodeId))
      : undefined;
    if (mappedOwnerId !== undefined) {
      return sendToHost(mappedOwnerId, request);
    }

    let hostIds = resolveReadyHostIds(
      runtime,
      readyHostIds,
      request.workspaceId,
      request.surfaceRole
    );
    if (hostIds.length === 0 && request.surfaceRole === "agent") {
      const agentSessionId = request.agentSessionId?.trim() ?? "";
      if (!agentSessionId) {
        throw new Error("Agent Browser request requires an agent session");
      }
      await options.ensureAgentBrowserHost({
        agentSessionId,
        workspaceId: request.workspaceId
      });
      await waitForReadyHost(
        runtime,
        readyHostIds,
        readyWaiters,
        request.workspaceId,
        request.surfaceRole
      );
      hostIds = resolveReadyHostIds(
        runtime,
        readyHostIds,
        request.workspaceId,
        request.surfaceRole
      );
    }
    if (hostIds.length === 0) {
      throw new Error(
        `No ${request.surfaceRole} Browser surface host is available for workspace ${request.workspaceId}`
      );
    }

    let lastError: unknown;
    for (const senderId of hostIds) {
      try {
        return await sendToHost(senderId, request);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("In-app Browser surface request failed");
  };

  return {
    async closeTarget(target) {
      await send({
        action: "close",
        agentSessionId: target.agentSessionId ?? null,
        nodeId: target.nodeId,
        surfaceRole: target.surfaceRole,
        url: null,
        workspaceId: target.workspaceId
      });
    },
    dispose() {
      runtime.ipc.off(
        desktopIpcChannels.browser.automationHostReady,
        handleHostReady
      );
      runtime.ipc.off(
        desktopIpcChannels.browser.automationResponse,
        handleResponse
      );
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error("In-app Browser automation stopped"));
      }
      pending.clear();
      readyHostIds.clear();
      for (const waiters of readyWaiters.values()) {
        for (const resolve of waiters) resolve();
      }
      readyWaiters.clear();
      targetOwnerIds.clear();
    },
    requestTarget(input) {
      return send({
        action: "create",
        agentSessionId: input.agentSessionId,
        nodeId: input.requestedPageId ?? null,
        surfaceRole: input.agentSessionId ? "agent" : "user",
        url: input.url ?? null,
        workspaceId: input.workspaceId
      });
    },
    async selectTarget(target) {
      await send({
        action: "select",
        agentSessionId: target.agentSessionId ?? null,
        nodeId: target.nodeId,
        surfaceRole: target.surfaceRole,
        url: null,
        workspaceId: target.workspaceId
      });
    }
  };
}

function hostKey(workspaceId: string, surfaceRole: "agent" | "user"): string {
  return `${workspaceId}\u0000${surfaceRole}`;
}

function targetKey(workspaceId: string, nodeId: string): string {
  return `${workspaceId}\u0000${nodeId}`;
}

function resolveReadyHostIds(
  runtime: NonNullable<DesktopBrowserAutomationCoordinatorOptions["runtime"]>,
  readyHostIds: Map<string, Set<number>>,
  workspaceId: string,
  surfaceRole: "agent" | "user"
): number[] {
  const key = hostKey(workspaceId, surfaceRole);
  const hostIds = readyHostIds.get(key);
  if (!hostIds) return [];
  const active: number[] = [];
  for (const senderId of hostIds) {
    const sender = runtime.resolveWebContents(senderId);
    if (!sender || sender.isDestroyed()) {
      hostIds.delete(senderId);
    } else {
      active.push(senderId);
    }
  }
  if (hostIds.size === 0) readyHostIds.delete(key);
  return active.reverse();
}

function removeReadyHost(
  readyHostIds: Map<string, Set<number>>,
  senderId: number
): void {
  for (const [key, hostIds] of readyHostIds) {
    hostIds.delete(senderId);
    if (hostIds.size === 0) readyHostIds.delete(key);
  }
}

async function waitForReadyHost(
  runtime: NonNullable<DesktopBrowserAutomationCoordinatorOptions["runtime"]>,
  readyHostIds: Map<string, Set<number>>,
  readyWaiters: Map<string, Set<() => void>>,
  workspaceId: string,
  surfaceRole: "agent" | "user"
): Promise<void> {
  if (
    resolveReadyHostIds(runtime, readyHostIds, workspaceId, surfaceRole)
      .length > 0
  ) {
    return;
  }
  const key = hostKey(workspaceId, surfaceRole);
  await new Promise<void>((resolve, reject) => {
    const waiters = readyWaiters.get(key) ?? new Set<() => void>();
    const handleReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      waiters.delete(handleReady);
      if (waiters.size === 0) readyWaiters.delete(key);
      reject(new Error("In-app Browser surface host did not become ready"));
    }, requestTimeoutMs);
    waiters.add(handleReady);
    readyWaiters.set(key, waiters);
  });
}
