import { DeviceService } from "./deviceService";
import type { AccountSession, DevicePairingChallenge } from "./mobileDomain";
import type {
  ClockPort,
  MobileDiagnosticEvent,
  PairingPort,
  QRCodeScannerPort
} from "./servicePorts";

const session: AccountSession = {
  email: "person@example.com",
  name: "Person",
  sessionId: "session-cookie",
  userId: "user-1"
};
const pairingCode = JSON.stringify({
  challengeId: "challenge-1",
  secret: "a".repeat(43),
  version: 1
});

describe("DeviceService pairing lifecycle", () => {
  test("keeps an Android scanner interaction alive across background and active transitions", async () => {
    const scannerResult = deferred<string>();
    const harness = createHarness({
      scanner: scannerFrom(scannerResult)
    });

    const pairing = harness.service.scanAndPair();
    expect(harness.service.getSnapshot().pairingState).toBe("scanning");

    harness.service.suspendRemoteOperations();
    expect(harness.service.getSnapshot().pairingState).toBe("scanning");
    scannerResult.resolve(pairingCode);
    await flushPromises();

    expect(harness.claimCalls).toBe(0);
    expect(harness.service.getSnapshot().pairingState).toBe("scanning");

    harness.service.resumeRemoteOperations();
    await flushPromises();

    expect(harness.claimCalls).toBe(1);
    expect(harness.service.getSnapshot().pairingState).toBe("waiting");

    harness.clock.advanceBy(1_000);
    await pairing;

    expect(harness.challengeCalls).toBe(1);
    expect(harness.service.getSnapshot().pairingState).toBe("confirmed");
    expect(
      harness.diagnosticEvents
        .filter((event) => event.name === "device_pairing.phase_changed")
        .map((event) => event.phase)
    ).toEqual(["scanning", "claiming", "waiting", "confirmed"]);
    expect(JSON.stringify(harness.diagnosticEvents)).not.toContain(
      "a".repeat(43)
    );
  });

  test("starts only one scanner interaction while scanning", async () => {
    const scannerResult = deferred<string>();
    let scanCalls = 0;
    const harness = createHarness({
      scanner: {
        start: () => {
          scanCalls += 1;
          return {
            cancel: async () => undefined,
            result: scannerResult.promise
          };
        }
      }
    });

    const first = harness.service.scanAndPair();
    const duplicate = harness.service.scanAndPair();
    expect(scanCalls).toBe(1);

    harness.service.dispose();
    scannerResult.resolve(pairingCode);
    await Promise.all([first, duplicate]);

    expect(harness.claimCalls).toBe(0);
  });

  test.each([
    ["SCAN_CANCELLED", null],
    ["SCANNER_PERMISSION_DENIED", "camera_permission_required"],
    ["SCAN_FAILED", "scanner_unavailable"]
  ] as const)(
    "maps scanner failure %s without attempting a claim",
    async (code, errorCode) => {
      const harness = createHarness({
        scanner: {
          start: () => ({
            cancel: async () => undefined,
            result: Promise.reject({ code })
          })
        }
      });

      await harness.service.scanAndPair();
      harness.service.resumeRemoteOperations();
      await flushPromises();

      expect(harness.claimCalls).toBe(0);
      expect(harness.service.getSnapshot()).toMatchObject({
        errorCode,
        pairingState: "idle"
      });
    }
  );

  test("cancels the native scanner when the service is disposed", async () => {
    const scannerResult = deferred<string>();
    let cancelCalls = 0;
    const harness = createHarness({
      scanner: {
        start: () => ({
          cancel: async () => {
            cancelCalls += 1;
            scannerResult.reject({ code: "SCAN_CANCELLED" });
          },
          result: scannerResult.promise
        })
      }
    });

    const pairing = harness.service.scanAndPair();
    harness.service.dispose();
    await pairing;

    expect(cancelCalls).toBe(1);
    expect(harness.claimCalls).toBe(0);
  });

  test("settles an in-flight claim and resumes polling after returning active", async () => {
    const claimResult = deferred<DevicePairingChallenge>();
    const harness = createHarness({ claimResult });

    const pairing = harness.service.pairWithCode(pairingCode);
    await flushPromises();
    expect(harness.claimCalls).toBe(1);

    harness.service.suspendRemoteOperations();
    claimResult.resolve({
      challengeId: "challenge-1",
      expiresAt: new Date(10_000).toISOString(),
      state: "awaiting_confirmation"
    });

    await flushPromises();
    expect(harness.challengeCalls).toBe(0);
    expect(harness.service.getSnapshot().pairingState).toBe("claiming");

    harness.service.resumeRemoteOperations();
    await flushPromises();
    expect(harness.service.getSnapshot().pairingState).toBe("waiting");

    harness.clock.advanceBy(1_000);
    await expect(pairing).resolves.toBe(true);
    expect(harness.challengeCalls).toBe(1);
    expect(harness.service.getSnapshot().pairingState).toBe("confirmed");
  });

  test("reconciles an ambiguous in-flight claim without submitting it twice", async () => {
    const claimResult = deferred<DevicePairingChallenge>();
    const harness = createHarness({
      challengeResults: [
        {
          challengeId: "challenge-1",
          expiresAt: new Date(10_000).toISOString(),
          state: "awaiting_confirmation"
        }
      ],
      claimResult
    });

    const pairing = harness.service.pairWithCode(pairingCode);
    await flushPromises();
    expect(harness.claimCalls).toBe(1);

    harness.service.suspendRemoteOperations();
    claimResult.reject(new Error("claim response was lost"));
    harness.service.resumeRemoteOperations();
    await flushPromises();

    expect(harness.claimCalls).toBe(1);
    expect(harness.challengeCalls).toBe(1);
    expect(harness.service.getSnapshot().pairingState).toBe("waiting");

    harness.clock.advanceBy(1_000);
    await expect(pairing).resolves.toBe(true);
    expect(harness.claimCalls).toBe(1);
    expect(harness.challengeCalls).toBe(2);
  });

  test("retries claim reconciliation when a second background transition interrupts its read", async () => {
    const claimResult = deferred<DevicePairingChallenge>();
    const reconciliationResult = deferred<DevicePairingChallenge>();
    const harness = createHarness({
      challengeResults: [reconciliationResult.promise],
      claimResult
    });

    const pairing = harness.service.pairWithCode(pairingCode);
    await flushPromises();
    harness.service.suspendRemoteOperations();
    claimResult.reject(new Error("claim response was lost"));
    harness.service.resumeRemoteOperations();
    await flushPromises();
    expect(harness.challengeCalls).toBe(1);

    harness.service.suspendRemoteOperations();
    reconciliationResult.reject(new Error("reconciliation response was lost"));
    await flushPromises();
    expect(harness.service.getSnapshot().pairingState).toBe("claiming");

    harness.service.resumeRemoteOperations();
    await expect(pairing).resolves.toBe(true);

    expect(harness.claimCalls).toBe(1);
    expect(harness.challengeCalls).toBe(2);
    expect(harness.service.getSnapshot().pairingState).toBe("confirmed");
  });

  test("holds a successful in-flight poll result until the app is active", async () => {
    const pollResult = deferred<DevicePairingChallenge>();
    const harness = createHarness({
      challengeResults: [pollResult.promise]
    });

    const pairing = harness.service.pairWithCode(pairingCode);
    await flushPromises();
    harness.clock.advanceBy(1_000);
    await flushPromises();
    expect(harness.challengeCalls).toBe(1);

    harness.service.suspendRemoteOperations();
    pollResult.resolve({
      challengeId: "challenge-1",
      expiresAt: new Date(10_000).toISOString(),
      state: "confirmed"
    });
    await flushPromises();

    expect(harness.service.getSnapshot().pairingState).toBe("waiting");

    harness.service.resumeRemoteOperations();
    await expect(pairing).resolves.toBe(true);
    expect(harness.challengeCalls).toBe(1);
    expect(harness.service.getSnapshot().pairingState).toBe("confirmed");
  });

  test("retries a read-only poll interrupted by a background transition", async () => {
    const pollResult = deferred<DevicePairingChallenge>();
    const harness = createHarness({
      challengeResults: [pollResult.promise]
    });

    const pairing = harness.service.pairWithCode(pairingCode);
    await flushPromises();
    harness.clock.advanceBy(1_000);
    await flushPromises();
    expect(harness.challengeCalls).toBe(1);

    harness.service.suspendRemoteOperations();
    pollResult.reject(new Error("poll response was lost"));
    await flushPromises();
    expect(harness.service.getSnapshot().pairingState).toBe("waiting");

    harness.service.resumeRemoteOperations();
    await expect(pairing).resolves.toBe(true);
    expect(harness.challengeCalls).toBe(2);
    expect(harness.service.getSnapshot().pairingState).toBe("confirmed");
  });

  test("rejects invalid manual pairing codes before calling the gateway", async () => {
    const harness = createHarness();

    await expect(harness.service.pairWithCode("not-json")).resolves.toBe(false);

    expect(harness.claimCalls).toBe(0);
    expect(harness.service.getSnapshot()).toMatchObject({
      errorCode: "pairing_failed",
      pairingState: "idle"
    });
  });
});

function createHarness({
  challengeResults = [],
  claimResult,
  scanner = {
    start: () => ({
      cancel: async () => undefined,
      result: Promise.resolve(pairingCode)
    })
  }
}: {
  challengeResults?: Array<
    DevicePairingChallenge | Promise<DevicePairingChallenge>
  >;
  claimResult?: Deferred<DevicePairingChallenge>;
  scanner?: QRCodeScannerPort;
} = {}) {
  const clock = new ManualClock();
  const diagnosticEvents: MobileDiagnosticEvent[] = [];
  let challengeCalls = 0;
  let claimCalls = 0;
  const pairing: PairingPort = {
    claimPairing: async () => {
      claimCalls += 1;
      return claimResult
        ? claimResult.promise
        : {
            challengeId: "challenge-1",
            expiresAt: new Date(10_000).toISOString(),
            state: "awaiting_confirmation"
          };
    },
    connectPairedDevice: async () => undefined,
    getPairingChallenge: async () => {
      challengeCalls += 1;
      return (
        (await challengeResults.shift()) ?? {
          challengeId: "challenge-1",
          expiresAt: new Date(10_000).toISOString(),
          state: "confirmed"
        }
      );
    },
    listDevices: async () => [],
    listPairings: async () => [],
    registerCurrentDevice: async () => ({ userDeviceId: "mobile-1" })
  };
  const service = new DeviceService(
    session,
    pairing,
    scanner,
    { record: (event) => diagnosticEvents.push(event) },
    clock,
    async () => undefined
  );
  return {
    get challengeCalls() {
      return challengeCalls;
    },
    get claimCalls() {
      return claimCalls;
    },
    clock,
    diagnosticEvents,
    service
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(cause: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (cause: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    reject = rejecter;
    resolve = resolver;
  });
  return { promise, reject, resolve };
}

function scannerFrom(result: Deferred<string>): QRCodeScannerPort {
  return {
    start: () => ({
      cancel: async () => {
        result.reject({ code: "SCAN_CANCELLED" });
      },
      result: result.promise
    })
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
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
