import type {
  TuttidClient,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { InstantiationService } from "@tutti-os/infra/di";
import type { AccountSession } from "./mobileDomain";
import { MobileApplicationService } from "./mobileApplicationService";
import type {
  AppLifecycleState,
  ClockPort,
  MobileServicePorts
} from "./servicePorts";

const session: AccountSession = {
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
    login.setEmail(session.email);
    await login.submitEmail();
    login.setCode("123456");
    await login.submitEmail();

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

    harness.clock.advanceBy(1);
    await flushPromises();
    expect(harness.closeCalls).toBe(1);
    expect(harness.connectCalls).toBe(2);
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
    closeLink?(): Promise<void>;
  } = {}
): {
  clock: ManualClock;
  closeCalls: number;
  connectCalls: number;
  emitAgentLiveConnection(status: "connected" | "disconnected"): void;
  emitLifecycle(state: AppLifecycleState): void;
  failNextConnection(): void;
  legacyCookieClearCalls: number;
  ports: MobileServicePorts;
  registerCalls: number;
} {
  const clock = new ManualClock();
  let lifecycleListener: ((state: AppLifecycleState) => void) | null = null;
  let liveListener:
    | Parameters<MobileServicePorts["deviceLink"]["subscribeAgentLive"]>[1]
    | null = null;
  let failNextConnection = false;
  const harness = {
    clock,
    closeCalls: 0,
    connectCalls: 0,
    emitAgentLiveConnection(status: "connected" | "disconnected") {
      liveListener?.({ kind: "connection", status });
    },
    legacyCookieClearCalls: 0,
    registerCalls: 0,
    emitLifecycle(state: AppLifecycleState) {
      lifecycleListener?.(state);
    },
    failNextConnection() {
      failNextConnection = true;
    },
    ports: null as unknown as MobileServicePorts
  };
  harness.ports = {
    account: {
      sendEmailCode: async () => undefined,
      signInWithGitHub: async () => session,
      verifyEmailCode: async () => session
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
        listAgentTargets: async () => ({ targets: [] }),
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
      requestAgentHTTP: async () => ({
        body: "",
        errorCode: "",
        headers: {},
        protocolEpoch: 1,
        status: 204
      }),
      subscribeAgentLive: (_workspaceId, listener) => {
        liveListener = listener;
        return {
          close() {
            if (liveListener === listener) liveListener = null;
          }
        };
      }
    },
    diagnostics: {
      record: () => undefined
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
        result: Promise.resolve("")
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
