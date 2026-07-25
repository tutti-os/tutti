import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { InstantiationService } from "@tutti-os/infra/di";
import type { AccountSession } from "./mobileDomain";
import { MobileApplicationService } from "./mobileApplicationService";
import type { ClockPort, MobileServicePorts } from "./servicePorts";

const session: AccountSession = {
  email: "person@example.com",
  name: "Person",
  sessionId: "session-cookie",
  userId: "user-1"
};

describe("MobileApplicationService scopes", () => {
  test("replaces the unauthenticated child with one authenticated child", async () => {
    const harness = createHarness(null);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();

    expect(service.getSnapshot().route).toBe("login");
    const login = service.loginService!;
    login.setEmail(session.email);
    await login.submitEmail();
    login.setCode("123456");
    await login.submitEmail();

    expect(service.getSnapshot().route).toBe("devices");
    expect(service.loginService).toBeNull();
    expect(service.deviceService).not.toBeNull();

    await service.signOut();
    expect(service.getSnapshot().route).toBe("login");
    expect(service.deviceService).toBeNull();
  });

  test("background grace closes DeviceLink only after the deadline", async () => {
    const harness = createHarness(session);
    const service = new MobileApplicationService(
      new InstantiationService(),
      harness.ports
    );
    await service.start();

    harness.emitLifecycle(false);
    expect(harness.closeCalls).toBe(0);
    harness.clock.advanceBy(14_999);
    expect(harness.closeCalls).toBe(0);
    harness.clock.advanceBy(1);
    await Promise.resolve();
    expect(harness.closeCalls).toBe(1);
    expect(service.getSnapshot().route).toBe("devices");
  });
});

function createHarness(storedSession: AccountSession | null): {
  clock: ManualClock;
  closeCalls: number;
  emitLifecycle(active: boolean): void;
  ports: MobileServicePorts;
} {
  const clock = new ManualClock();
  let lifecycleListener: ((active: boolean) => void) | null = null;
  const harness = {
    clock,
    closeCalls: 0,
    emitLifecycle(active: boolean) {
      lifecycleListener?.(active);
    },
    ports: null as unknown as MobileServicePorts
  };
  harness.ports = {
    account: {
      sendEmailCode: async () => undefined,
      signInWithGitHub: async () => session,
      verifyEmailCode: async () => session
    },
    clock,
    createRemoteClient: () =>
      ({
        listAgentTargets: async () => ({ targets: [] }),
        listWorkspaces: async () => ({ workspaces: [] })
      }) as unknown as TuttidClient,
    deviceLink: {
      closeLink: async () => {
        harness.closeCalls += 1;
      },
      requestAgentHTTP: async () => ({
        body: "",
        errorCode: "",
        headers: {},
        protocolEpoch: 1,
        status: 204
      })
    },
    deviceSecurity: {
      getOrCreateIdentity: async () => ({
        arch: "arm64",
        deviceId: "mobile-1",
        deviceName: "Phone",
        publicKey: "public-key"
      }),
      scanQRCode: async () => "",
      sign: async () => ""
    },
    lifecycle: {
      subscribe(listener) {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = null;
        };
      }
    },
    pairing: {
      claimPairing: async () => ({
        challengeId: "challenge-1",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        state: "claimed"
      }),
      connectPairedDevice: async () => undefined,
      getPairingChallenge: async () => ({
        challengeId: "challenge-1",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        state: "confirmed"
      }),
      listDevices: async () => [],
      listPairings: async () => [],
      parsePairingQR: () => ({
        challengeId: "challenge-1",
        secret: "secret",
        version: 1
      }),
      registerCurrentDevice: async () => ({ userDeviceId: "mobile-1" })
    },
    sessionStorage: {
      clearSession: async () => undefined,
      clearSessionCookie: async () => undefined,
      installSessionCookie: async () => undefined,
      loadSession: async () => storedSession,
      saveSession: async () => undefined
    }
  };
  return harness;
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
