import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { InstantiationService } from "@tutti-os/infra/di";
import type { AccountSession } from "./mobileDomain";
import { MobileApplicationService } from "./mobileApplicationService";
import type {
  AgentLiveDelivery,
  AppLifecycleState,
  ClockPort,
  MobileDiagnosticEvent,
  MobileServicePorts
} from "./servicePorts";

const session: AccountSession = {
  avatarURL: "https://example.com/person.png",
  email: "person@example.com",
  name: "Person",
  sessionId: "session-cookie",
  userId: "user-1"
};
const workspace: WorkspaceSummary = {
  id: "workspace-1",
  lastOpenedAt: null,
  name: "Personal"
};
const pairing = {
  controllerUserDeviceId: "mobile-1",
  pairingId: "pairing-1",
  revision: "1",
  state: "active" as const,
  targetUserDeviceId: "desktop-1"
};

describe("MobileApplicationService scopes", () => {
  test("replaces the unauthenticated child with one authenticated child", async () => {
    const harness = createHarness(null);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();

    expect(service.getSnapshot().status).toBe("unauthenticated");
    expect(harness.legacyCookieClearCalls).toBe(1);

    const login = service.loginService!;
    await login.submitLogin();

    expect(service.getSnapshot()).toMatchObject({
      device: null,
      status: "authenticated",
      workspace: null
    });
    expect(service.loginService).toBeNull();
    expect(service.deviceService).not.toBeNull();

    await service.signOut();
    expect(service.getSnapshot().status).toBe("unauthenticated");
    expect(service.deviceService).toBeNull();
    expect(harness.legacyCookieClearCalls).toBe(2);
  });

  test("reconnects after the native background deadline without dropping the workspace", async () => {
    const harness = createHarness(session, [workspace]);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);
    harness.emitAgentLiveConnection("connected");
    const previousActivity = service.workspaceActivityService!;
    previousActivity.startCreating();
    previousActivity.setDraft("RECOVERY_DRAFT");
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "connected" },
      device: { pairingId: pairing.pairingId },
      workspace: { id: workspace.id }
    });

    harness.emitLifecycle("background");
    expect(harness.closeCalls).toBe(0);
    harness.clock.advanceBy(15_000);
    expect(harness.closeCalls).toBe(0);
    harness.emitLifecycle("foreground");
    await service.retryDeviceConnection();

    expect(harness.closeCalls).toBe(1);
    expect(harness.connectCalls).toBe(2);
    expect(service.getSnapshot()).toMatchObject({
      connection: {
        phase: "synchronizing",
        trigger: "background_expired"
      },
      device: { pairingId: pairing.pairingId },
      status: "authenticated",
      workspace: { id: workspace.id }
    });
    harness.emitAgentLiveConnection("connected");
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "connected" },
      workspace: { id: workspace.id }
    });
    expect(service.workspaceActivityService).not.toBe(previousActivity);
    expect(service.workspaceActivityService!.getSnapshot()).toMatchObject({
      creating: true,
      draft: "RECOVERY_DRAFT"
    });
  });

  test("lets the live stream retry briefly before rebuilding a lost DeviceLink", async () => {
    const harness = createHarness(session, [workspace]);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);
    harness.emitAgentLiveConnection("connected");

    harness.emitAgentLiveConnection("disconnected");
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "synchronizing", trigger: "transport_lost" },
      workspace: { id: workspace.id }
    });
    harness.clock.advanceBy(1_499);
    await flushPromises();
    expect(harness.closeCalls).toBe(0);
    expect(harness.connectCalls).toBe(1);

    harness.emitAgentLiveConnection("disconnected");

    harness.clock.advanceBy(1);
    await flushPromises();
    expect(harness.closeCalls).toBe(1);
    expect(harness.connectCalls).toBe(2);
  });

  test("stops retrying and reports incompatible Agent live revisions", async () => {
    const harness = createHarness(session, [workspace]);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);

    harness.emitAgentLiveConnection("disconnected", {
      expectedRevision: "sha256:new",
      reason: "protocol_revision_mismatch",
      receivedRevision: "sha256:old",
      retryable: false
    });

    expect(service.getSnapshot()).toMatchObject({
      connection: {
        expectedRevision: "sha256:new",
        phase: "failed",
        reasonCode: "protocol_revision_mismatch",
        receivedRevision: "sha256:old",
        trigger: "initial_connect"
      },
      workspace: { id: workspace.id }
    });
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.diagnosticEvents).toContainEqual({
      expectedRevision: "sha256:new",
      name: "device_connection.phase_changed",
      phase: "failed",
      reasonCode: "protocol_revision_mismatch",
      receivedRevision: "sha256:old",
      trigger: "initial_connect"
    });

    harness.clock.advanceBy(30_000);
    await flushPromises();
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.closeCalls).toBe(0);
    expect(harness.connectCalls).toBe(1);

    harness.emitLifecycle("background");
    harness.clock.advanceBy(15_000);
    harness.emitLifecycle("foreground");
    await flushPromises();
    expect(service.getSnapshot()).toMatchObject({
      connection: {
        phase: "failed",
        reasonCode: "protocol_revision_mismatch"
      }
    });
    expect(harness.closeCalls).toBe(0);
    expect(harness.connectCalls).toBe(1);
  });

  test("preserves a synchronous protocol rejection during workspace startup", async () => {
    const harness = createHarness(session, [workspace], {
      agentLiveDeliveriesOnSubscribe: [
        {
          expectedRevision: "sha256:new",
          kind: "connection",
          reason: "protocol_revision_mismatch",
          receivedRevision: "sha256:old",
          retryable: false,
          status: "disconnected"
        }
      ]
    });
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);

    expect(service.getSnapshot()).toMatchObject({
      connection: {
        expectedRevision: "sha256:new",
        phase: "failed",
        reasonCode: "protocol_revision_mismatch",
        receivedRevision: "sha256:old",
        trigger: "initial_connect"
      },
      workspace: { id: workspace.id }
    });
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.subscriptionCloseCalls).toBe(1);

    harness.clock.advanceBy(30_000);
    expect(harness.subscribeCalls).toBe(1);
  });

  test("retries after a synchronous retryable stream close", async () => {
    const harness = createHarness(session, [workspace], {
      agentLiveDeliveriesOnSubscribe: [
        {
          kind: "connection",
          reason: "stream_closed",
          retryable: true,
          status: "disconnected"
        },
        { kind: "connection", status: "connected" }
      ]
    });
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);

    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "synchronizing", trigger: "initial_connect" }
    });
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.subscriptionCloseCalls).toBe(1);

    harness.clock.advanceBy(999);
    expect(harness.subscribeCalls).toBe(1);
    harness.clock.advanceBy(1);

    expect(harness.subscribeCalls).toBe(2);
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "connected" }
    });
  });

  test("keeps the workspace available after recovery fails and retries explicitly", async () => {
    const harness = createHarness(session, [workspace]);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);
    harness.emitAgentLiveConnection("connected");
    harness.failNextConnection();

    harness.emitLifecycle("background");
    harness.clock.advanceBy(15_000);
    harness.emitLifecycle("foreground");
    await service.retryDeviceConnection();
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "failed", trigger: "background_expired" },
      device: { pairingId: pairing.pairingId },
      workspace: { id: workspace.id }
    });

    await service.retryDeviceConnection();
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "synchronizing", trigger: "manual_retry" },
      workspace: { id: workspace.id }
    });
    harness.emitAgentLiveConnection("connected");
    expect(service.getSnapshot()).toMatchObject({
      connection: { phase: "connected" }
    });
  });

  test("creates an authenticated device scope at the current process lifecycle level", async () => {
    const storedSession = deferred<AccountSession | null>();
    const harness = createHarness(storedSession.promise);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );

    const start = service.start();
    harness.emitLifecycle("background");
    storedSession.resolve(session);
    await start;

    expect(service.getSnapshot().status).toBe("authenticated");
    expect(harness.registerCalls).toBe(0);

    harness.emitLifecycle("foreground");
    await flushPromises();
    expect(harness.registerCalls).toBe(1);
  });

  test("opens the only Personal workspace after connecting a device", async () => {
    const harness = createHarness(session, [workspace]);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();

    await service.deviceService!.connect(pairing);

    expect(service.getSnapshot()).toMatchObject({
      device: { pairingId: pairing.pairingId },
      status: "authenticated",
      workspace: { id: workspace.id }
    });
  });

  test("measures latency only while the DeviceLink is connected", async () => {
    const harness = createHarness(session, [workspace]);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();

    await expect(service.measureConnectionLatency()).resolves.toBeNull();
    expect(harness.requestCalls).toBe(0);

    await service.deviceService!.connect(pairing);
    harness.emitAgentLiveConnection("connected");
    const now = jest
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_042);
    await expect(service.measureConnectionLatency()).resolves.toBe(42);
    now.mockRestore();
    expect(harness.requestCalls).toBe(1);

    harness.failNextLatencyProbe();
    await expect(service.measureConnectionLatency()).resolves.toBeNull();
    expect(harness.requestCalls).toBe(2);
  });

  test("clears the device atomically and blocks reconnect until close finishes", async () => {
    const close = deferred<void>();
    const harness = createHarness(session, [workspace], {
      closeLink: () => close.promise
    });
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();
    await service.deviceService!.connect(pairing);
    expect(harness.connectCalls).toBe(1);

    const disconnect = service.disconnectDevice();
    const duplicateDisconnect = service.disconnectDevice();

    expect(duplicateDisconnect).toBe(disconnect);
    expect(service.getSnapshot()).toMatchObject({
      device: null,
      status: "authenticated",
      workspace: null
    });
    expect(service.workspaceActivityService).toBeNull();
    await service.deviceService!.connect(pairing);
    expect(harness.connectCalls).toBe(1);
    await flushPromises();
    expect(harness.closeCalls).toBe(1);

    close.resolve(undefined);
    await disconnect;
    await service.deviceService!.connect(pairing);
    expect(harness.connectCalls).toBe(2);
  });

  test.each([
    ["no", []],
    ["multiple", [workspace, { ...workspace, id: "workspace-2" }]]
  ])(
    "rejects a Personal device with %s workspaces",
    async (_label, workspaces) => {
      const harness = createHarness(session, workspaces);
      const service = new MobileApplicationService(
        new InstantiationService(),
        harness.ports
      );
      await service.start();

      await service.deviceService!.connect(pairing);

      expect(service.getSnapshot()).toMatchObject({
        device: null,
        status: "authenticated",
        workspace: null
      });
      expect(service.deviceService!.getSnapshot().errorCode).toBe(
        "workspace_unavailable"
      );
      expect(harness.closeCalls).toBe(1);
    }
  );
});

function createHarness(
  storedSession: AccountSession | null | Promise<AccountSession | null>,
  workspaces: readonly WorkspaceSummary[] = [],
  overrides: {
    agentLiveDeliveriesOnSubscribe?: readonly AgentLiveDelivery[];
    closeLink?(): Promise<void>;
  } = {}
): {
  clock: ManualClock;
  closeCalls: number;
  connectCalls: number;
  diagnosticEvents: MobileDiagnosticEvent[];
  emitAgentLiveConnection(
    status: "connected" | "disconnected",
    failure?: Pick<
      Extract<
        AgentLiveDelivery,
        { kind: "connection"; status: "disconnected" }
      >,
      "expectedRevision" | "reason" | "receivedRevision" | "retryable"
    >
  ): void;
  emitLifecycle(state: AppLifecycleState): void;
  failNextConnection(): void;
  failNextLatencyProbe(): void;
  legacyCookieClearCalls: number;
  ports: MobileServicePorts;
  registerCalls: number;
  requestCalls: number;
  subscribeCalls: number;
  subscriptionCloseCalls: number;
} {
  const clock = new ManualClock();
  let lifecycleListener: ((state: AppLifecycleState) => void) | null = null;
  let liveListener:
    | Parameters<MobileServicePorts["deviceLink"]["subscribeAgentLive"]>[1]
    | null = null;
  let failNextConnection = false;
  let failNextLatencyProbe = false;
  const agentLiveDeliveriesOnSubscribe = [
    ...(overrides.agentLiveDeliveriesOnSubscribe ?? [])
  ];
  const harness = {
    clock,
    closeCalls: 0,
    connectCalls: 0,
    diagnosticEvents: [] as MobileDiagnosticEvent[],
    emitAgentLiveConnection(
      status: "connected" | "disconnected",
      failure?: Pick<
        Extract<
          AgentLiveDelivery,
          { kind: "connection"; status: "disconnected" }
        >,
        "expectedRevision" | "reason" | "receivedRevision" | "retryable"
      >
    ) {
      if (status === "connected") {
        liveListener?.({ kind: "connection", status });
        return;
      }
      liveListener?.({
        kind: "connection",
        reason: failure?.reason ?? "stream_closed",
        retryable: failure?.retryable ?? true,
        status,
        ...(failure?.expectedRevision
          ? { expectedRevision: failure.expectedRevision }
          : {}),
        ...(failure?.receivedRevision
          ? { receivedRevision: failure.receivedRevision }
          : {})
      });
    },
    legacyCookieClearCalls: 0,
    registerCalls: 0,
    emitLifecycle(state: AppLifecycleState) {
      lifecycleListener?.(state);
    },
    failNextConnection() {
      failNextConnection = true;
    },
    failNextLatencyProbe() {
      failNextLatencyProbe = true;
    },
    ports: null as unknown as MobileServicePorts,
    requestCalls: 0,
    subscribeCalls: 0,
    subscriptionCloseCalls: 0
  };
  harness.ports = {
    account: {
      signInWithBrowser: async () => session
    },
    appLifecycle: {
      subscribe(listener) {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = null;
        };
      }
    },
    clock,
    createRemoteClient: () =>
      ({
        getDesktopPreferences: async () => ({
          preferences: { featureFlags: {} }
        }),
        listAgentQuickPrompts: async () => ({ prompts: [] }),
        listAgentTargets: async () => ({ targets: [] }),
        listUserProjects: async () => ({ projects: [] }),
        listWorkspaceAgentSessionSections: async () => ({
          pinned: { hasMore: false, sessions: [], totalCount: 0 },
          sections: [],
          workspaceId: workspace.id
        }),
        listWorkspaces: async () => ({ workspaces })
      }) as unknown as TuttidClient,
    deviceLink: {
      closeLink: async () => {
        harness.closeCalls += 1;
        await overrides.closeLink?.();
      },
      requestAgentHTTP: async () => {
        harness.requestCalls += 1;
        if (failNextLatencyProbe) {
          failNextLatencyProbe = false;
          throw new Error("latency probe failed");
        }
        return {
          body: "",
          errorCode: "",
          headers: {},
          protocolEpoch: 1,
          status: 204
        };
      },
      subscribeAgentLive: (_workspaceId, listener) => {
        harness.subscribeCalls += 1;
        liveListener = listener;
        const delivery = agentLiveDeliveriesOnSubscribe.shift();
        if (delivery) listener(delivery);
        return {
          close() {
            harness.subscriptionCloseCalls += 1;
            if (liveListener === listener) liveListener = null;
          }
        };
      }
    },
    diagnostics: {
      record: (event) => harness.diagnosticEvents.push(event)
    },
    legacySessionCookie: {
      clear: async () => {
        harness.legacyCookieClearCalls += 1;
      }
    },
    pairing: {
      claimPairing: async () => ({
        challengeId: "challenge-1",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        state: "awaiting_confirmation"
      }),
      connectPairedDevice: async () => {
        harness.connectCalls += 1;
        if (failNextConnection) {
          failNextConnection = false;
          throw new Error("connection failed");
        }
        return "local_subnet" as const;
      },
      getPairingChallenge: async () => ({
        challengeId: "challenge-1",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        state: "confirmed"
      }),
      listDevices: async () => [],
      listPairings: async () => [],
      registerCurrentDevice: async () => {
        harness.registerCalls += 1;
        return { userDeviceId: "mobile-1" };
      }
    },
    qrCodeScanner: {
      start: () => ({
        cancel: async () => undefined,
        result: Promise.resolve({ kind: "scanned", value: "" })
      })
    },
    sessionStorage: {
      clearSession: async () => undefined,
      loadSession: async () => storedSession,
      saveSession: async () => undefined
    }
  };
  return harness;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

class ManualClock implements ClockPort {
  private nowValue = 0;
  private readonly tasks: Array<{
    at: number;
    canceled: boolean;
    callback(): void;
  }> = [];

  now(): number {
    return this.nowValue;
  }

  schedule(delayMs: number, callback: () => void): { cancel(): void } {
    const task = {
      at: this.nowValue + delayMs,
      callback,
      canceled: false
    };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.canceled = true;
      }
    };
  }

  advanceBy(delayMs: number): void {
    this.nowValue += delayMs;
    for (const task of this.tasks) {
      if (!task.canceled && task.at <= this.nowValue) {
        task.canceled = true;
        task.callback();
      }
    }
  }
}
