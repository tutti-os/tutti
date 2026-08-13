jest.mock("../native/mobileNative", () => ({
  __esModule: true,
  deviceLink: {
    closeLink: jest.fn(),
    cancelLink: jest.fn(),
    configureRelay: jest.fn(),
    connectLink: jest.fn(),
    nextCandidateExchangeAction: jest.fn(),
    notifyRemoteCandidateChange: jest.fn(),
    prepareLink: jest.fn(),
    probeRelay: jest.fn(),
    resolveCandidateExchangeAction: jest.fn(),
    stopCandidateExchange: jest.fn()
  },
  mobileSecurity: {
    getOrCreateIdentity: jest.fn(),
    sign: jest.fn()
  }
}));

import { deviceLink, mobileSecurity } from "../native/mobileNative";
import { connectTrickledDeviceLink } from "./deviceLinkCandidateExchange";
import {
  claimPairing,
  connectPairedDevice,
  issueAgentRelayDescriptor,
  registerCurrentDevice
} from "./pairingClient";
import {
  deviceLinkProof,
  identityProof,
  pairingClaimProof,
  parsePairingQR,
  standardBase64ToURL
} from "./pairingProtocol";
import { PAIRING_OPERATION_SUSPENDED } from "./servicePorts";

const mockGetOrCreateIdentity = jest.mocked(mobileSecurity.getOrCreateIdentity);
const mockSign = jest.mocked(mobileSecurity.sign);
const mockCancelLink = jest.mocked(deviceLink.cancelLink);
const mockCloseLink = jest.mocked(deviceLink.closeLink);
const mockConfigureRelay = jest.mocked(deviceLink.configureRelay!);
const mockConnectLink = jest.mocked(deviceLink.connectLink);
const mockNextCandidateExchangeAction = jest.mocked(
  deviceLink.nextCandidateExchangeAction
);
const mockNotifyRemoteCandidateChange = jest.mocked(
  deviceLink.notifyRemoteCandidateChange
);
const mockPrepareLink = jest.mocked(deviceLink.prepareLink);
const mockProbeRelay = jest.mocked(deviceLink.probeRelay);
const mockResolveCandidateExchangeAction = jest.mocked(
  deviceLink.resolveCandidateExchangeAction
);
const mockStopCandidateExchange = jest.mocked(deviceLink.stopCandidateExchange);
let pendingCandidateActionRejects: Array<(error: Error) => void> = [];
let candidateExchangeStopped = false;

function controlPlaneResponse(data: unknown): Response {
  return {
    json: async () => data,
    ok: true,
    status: 200
  } as Response;
}

describe("control-plane authentication", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    pendingCandidateActionRejects = [];
    candidateExchangeStopped = false;
    mockCancelLink.mockResolvedValue(undefined);
    mockNextCandidateExchangeAction.mockImplementation(() => {
      if (candidateExchangeStopped) {
        return Promise.reject(new Error("candidate exchange stopped"));
      }
      return new Promise<string>((_resolve, reject) => {
        pendingCandidateActionRejects.push(reject);
      });
    });
    mockNotifyRemoteCandidateChange.mockResolvedValue(undefined);
    mockResolveCandidateExchangeAction.mockResolvedValue(0);
    mockStopCandidateExchange.mockImplementation(async () => {
      candidateExchangeStopped = true;
      mockNextCandidateExchangeAction.mockRejectedValue(
        new Error("candidate exchange stopped")
      );
      const rejects = pendingCandidateActionRejects;
      pendingCandidateActionRejects = [];
      for (const reject of rejects) {
        reject(new Error("candidate exchange stopped"));
      }
    });
  });

  it("uses only the explicit session cookie", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    mockSign.mockResolvedValue("proof-1");
    const fetchMock = jest.fn().mockResolvedValue(
      controlPlaneResponse({
        device: { userDeviceId: "user-device-1" }
      })
    );
    globalThis.fetch = fetchMock;

    await expect(registerCurrentDevice("session-1")).resolves.toEqual({
      userDeviceId: "user-device-1"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tutti.sh/api/desktop/v1/devices/current",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({
          Cookie: "session_id=session-1"
        }),
        method: "PUT"
      })
    );
  });

  it("does not send a claim after the operation is suspended", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await expect(
      claimPairing(
        "session-1",
        {
          challengeId: "challenge-1",
          secret: "a".repeat(43),
          version: 1
        },
        () => false
      )
    ).rejects.toMatchObject({ code: PAIRING_OPERATION_SUSPENDED });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a scoped Agent Relay descriptor with the relay proof", async () => {
    mockSign.mockResolvedValue("relay-signature");
    const fetchMock = jest.fn().mockResolvedValue(
      controlPlaneResponse({
        authorityId: "authority-1",
        relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
        token: "target-token",
        tokenExpiresAt: "2026-08-04T10:00:00Z"
      })
    );
    globalThis.fetch = fetchMock;

    await expect(
      issueAgentRelayDescriptor("session-1", "pairing-1", {
        arch: "arm64",
        deviceId: "device-1",
        deviceName: "Alice's iPhone",
        publicKey: "cHVibGljLWtleQ"
      })
    ).resolves.toEqual({
      authorityId: "authority-1",
      relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
      token: "target-token",
      tokenExpiresAt: "2026-08-04T10:00:00Z"
    });

    expect(mockSign).toHaveBeenCalledWith(
      deviceLinkProof("relay", "pairing-1", "", "")
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tutti.sh/api/desktop/v1/device-pairings/pairing-1/agent-relay-descriptor",
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: "device-1",
          identitySignature: "relay-signature",
          pairingId: "pairing-1"
        }),
        headers: expect.objectContaining({
          Cookie: "session_id=session-1"
        }),
        method: "POST"
      })
    );
  });

  it("rejects a Relay descriptor that is not a websocket endpoint", async () => {
    mockSign.mockResolvedValue("relay-signature");
    globalThis.fetch = jest.fn().mockResolvedValue(
      controlPlaneResponse({
        authorityId: "authority-1",
        relayDialEndpoint: "https://relay.example.test/not-websocket",
        token: "target-token",
        tokenExpiresAt: "2026-08-04T10:00:00Z"
      })
    );

    await expect(
      issueAgentRelayDescriptor("session-1", "pairing-1", {
        arch: "arm64",
        deviceId: "device-1",
        deviceName: "Alice's iPhone",
        publicKey: "cHVibGljLWtleQ"
      })
    ).rejects.toThrow("control-plane Relay descriptor is incomplete");
  });

  it("returns the existing path scope while Relay is ready first", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    mockSign.mockResolvedValue("signature");
    let resolvePrepareLink!: (value: {
      descriptionJSON: string;
      token: number;
    }) => void;
    mockPrepareLink.mockReturnValue(
      new Promise((resolve) => {
        resolvePrepareLink = resolve;
      })
    );
    mockConfigureRelay.mockResolvedValue(undefined);
    let resolveProbeRelay!: () => void;
    mockProbeRelay.mockReturnValue(
      new Promise((resolve) => {
        resolveProbeRelay = resolve;
      })
    );
    mockConnectLink.mockResolvedValue("local_subnet");
    globalThis.fetch = jest.fn().mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/devices/current")) {
        return Promise.resolve(
          controlPlaneResponse({ device: { userDeviceId: "user-device-1" } })
        );
      }
      if (url.includes("/agent-relay-descriptor")) {
        return Promise.resolve(
          controlPlaneResponse({
            authorityId: "authority-1",
            relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
            token: "target-token",
            tokenExpiresAt: "2026-08-04T10:00:00Z"
          })
        );
      }
      if (url.includes("/device-link-attempts")) {
        return Promise.resolve(
          controlPlaneResponse({
            attempt: {
              attemptId: "attempt-1",
              callerFingerprint: "fingerprint-1",
              callerIce: {
                candidates: ["candidate:local"],
                pwd: "password",
                ufrag: "username"
              },
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              ownerFingerprint: "owner-fingerprint-1",
              ownerIce: {
                candidates: ["candidate:owner"],
                pwd: "owner-password",
                ufrag: "owner-username"
              },
              state: "ready"
            }
          })
        );
      }
      throw new Error(`unexpected control-plane request: ${url}`);
    });

    let settled = false;
    const connection = connectPairedDevice("session-1", "pairing-1").then(
      (scope) => {
        settled = true;
        return scope;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(mockConfigureRelay).toHaveBeenCalledTimes(1);
    expect(mockProbeRelay).toHaveBeenCalledWith(10_000);
    expect(mockConnectLink).not.toHaveBeenCalled();
    expect(mockCloseLink).not.toHaveBeenCalled();

    resolveProbeRelay();
    await expect(connection).resolves.toBe("private_network");

    resolvePrepareLink({
      descriptionJSON: JSON.stringify({
        candidates: ["candidate:local"],
        fingerprint: "fingerprint-1",
        pwd: "password",
        ufrag: "username"
      }),
      token: 1
    });
    for (
      let attempt = 0;
      attempt < 20 && !mockConnectLink.mock.calls.length;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockConnectLink).toHaveBeenCalledTimes(1);
  });

  it("closes a prepared direct link when setup fails but Relay wins", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    mockSign.mockResolvedValue("signature");
    mockPrepareLink.mockResolvedValue({
      descriptionJSON: JSON.stringify({
        candidates: [],
        fingerprint: "caller-fingerprint",
        pwd: "caller-password",
        ufrag: "caller-username"
      }),
      token: 6
    });
    mockConfigureRelay.mockResolvedValue(undefined);
    mockProbeRelay.mockResolvedValue(undefined);
    globalThis.fetch = jest.fn().mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/devices/current")) {
        return Promise.resolve(
          controlPlaneResponse({ device: { userDeviceId: "user-device-1" } })
        );
      }
      if (url.includes("/agent-relay-descriptor")) {
        return Promise.resolve(
          controlPlaneResponse({
            authorityId: "authority-1",
            relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
            token: "target-token",
            tokenExpiresAt: "2026-08-04T10:00:00Z"
          })
        );
      }
      if (url.includes("/device-link-attempts")) {
        return Promise.resolve({
          json: async () => ({ code: "temporary_failure" }),
          ok: false,
          status: 503
        } as Response);
      }
      throw new Error(`unexpected control-plane request: ${url}`);
    });

    await expect(connectPairedDevice("session-1", "pairing-1")).resolves.toBe(
      "private_network"
    );
    for (
      let attempt = 0;
      attempt < 20 && !mockCancelLink.mock.calls.length;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(mockStopCandidateExchange).toHaveBeenCalledWith(6);
    expect(mockCancelLink).toHaveBeenCalledWith(6);
    expect(mockCloseLink).not.toHaveBeenCalled();
  });

  it("starts with empty candidates and trickles both participants while connecting", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    mockSign.mockResolvedValue("signature");
    mockPrepareLink.mockResolvedValue({
      descriptionJSON: JSON.stringify({
        candidates: [],
        fingerprint: "caller-fingerprint",
        pwd: "caller-password",
        ufrag: "caller-username"
      }),
      token: 7
    });
    const candidateActions = [
      JSON.stringify({
        actionId: 1,
        description: {
          candidates: ["candidate:caller"],
          fingerprint: "caller-fingerprint",
          pwd: "caller-password",
          ufrag: "caller-username"
        },
        kind: "publish_local"
      }),
      JSON.stringify({ actionId: 2, kind: "refresh_remote" })
    ];
    mockNextCandidateExchangeAction.mockImplementation(() => {
      const action = candidateActions.shift();
      if (action) return Promise.resolve(action);
      return new Promise<string>((_resolve, reject) => {
        pendingCandidateActionRejects.push(reject);
      });
    });
    mockConfigureRelay.mockResolvedValue(undefined);
    mockCloseLink.mockResolvedValue(undefined);
    mockProbeRelay.mockRejectedValue(new Error("relay unavailable"));
    let resolveConnect!: (scope: string) => void;
    let notifyAttempt: ((attemptId: string) => void) | undefined;
    mockConnectLink.mockImplementation(() => {
      return new Promise<string>((resolve) => {
        resolveConnect = resolve;
        setTimeout(() => notifyAttempt?.("attempt-1"), 0);
      });
    });
    mockResolveCandidateExchangeAction.mockImplementation(
      async (_actionId, succeeded, _retryable, candidatesJSON) => {
        if (!succeeded) return 0;
        const candidates = JSON.parse(candidatesJSON) as string[];
        if (candidates.includes("candidate:owner")) {
          resolveConnect("local_subnet");
          return 1;
        }
        return 0;
      }
    );

    const initialAttempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: {
        candidates: [],
        pwd: "caller-password",
        ufrag: "caller-username"
      },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ownerFingerprint: "owner-fingerprint",
      ownerIce: {
        candidates: [],
        pwd: "owner-password",
        ufrag: "owner-username"
      },
      state: "ready"
    };
    const fetchMock = jest
      .fn()
      .mockImplementation((input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/devices/current")) {
          return Promise.resolve(
            controlPlaneResponse({ device: { userDeviceId: "user-device-1" } })
          );
        }
        if (url.includes("/agent-relay-descriptor")) {
          return Promise.resolve(
            controlPlaneResponse({
              authorityId: "authority-1",
              relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
              token: "target-token",
              tokenExpiresAt: "2026-08-04T10:00:00Z"
            })
          );
        }
        if (url.includes("/device-link-attempts")) {
          if (init?.method === "GET") {
            return Promise.resolve(
              controlPlaneResponse({
                attempt: {
                  ...initialAttempt,
                  ownerIce: {
                    ...initialAttempt.ownerIce,
                    candidates: ["candidate:owner"]
                  }
                }
              })
            );
          }
          const body = JSON.parse(String(init?.body)) as {
            ephemeralFingerprint: string;
            ice: { candidates: string[]; pwd: string; ufrag: string };
          };
          return Promise.resolve(
            controlPlaneResponse({
              attempt: {
                ...initialAttempt,
                callerFingerprint: body.ephemeralFingerprint,
                callerIce: body.ice
              }
            })
          );
        }
        throw new Error(`unexpected control-plane request: ${url}`);
      });
    globalThis.fetch = fetchMock;
    const diagnostics: unknown[] = [];

    const connection = connectPairedDevice(
      "session-1",
      "pairing-1",
      () => true,
      {
        attemptEvents: {
          start(_sessionId, _deviceId, onAttempt) {
            notifyAttempt = onAttempt;
            return { close: jest.fn() };
          }
        },
        diagnostics: { record: (event) => diagnostics.push(event) }
      }
    );
    await expect(connection).resolves.toBe("local_subnet");

    expect(mockConnectLink).toHaveBeenCalledWith(
      JSON.stringify({
        candidates: [],
        fingerprint: "owner-fingerprint",
        pwd: "owner-password",
        ufrag: "owner-username"
      }),
      true,
      7,
      30_000
    );
    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      1,
      true,
      false,
      "[]",
      7
    );
    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      2,
      true,
      false,
      JSON.stringify(["candidate:owner"]),
      7
    );
    expect(mockNotifyRemoteCandidateChange).toHaveBeenCalledWith(7);
    expect(mockStopCandidateExchange).toHaveBeenCalledWith(7);
    expect(mockCancelLink).not.toHaveBeenCalled();
    const attemptWrites = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          String(input).includes("/device-link-attempts") &&
          (init as RequestInit | undefined)?.method === "POST"
      )
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(attemptWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ice: expect.objectContaining({ candidates: [] })
        }),
        expect.objectContaining({
          ice: expect.objectContaining({ candidates: ["candidate:caller"] })
        })
      ])
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "direct_credentials_ready" }),
        expect.objectContaining({ stage: "direct_first_candidate_published" }),
        expect.objectContaining({ stage: "direct_remote_candidate_received" }),
        expect.objectContaining({ stage: "direct_connected" })
      ])
    );
  });

  it("refreshes remote candidates while a local publication is still pending", async () => {
    const initialAttempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      state: "awaiting_owner" as const
    };
    const readyAttempt = {
      ...initialAttempt,
      ownerFingerprint: "owner-fingerprint",
      ownerIce: { candidates: [], pwd: "owner-pwd", ufrag: "owner-ufrag" },
      state: "ready" as const
    };
    const actions = [
      JSON.stringify({
        actionId: 20,
        description: {
          candidates: ["candidate:caller"],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        kind: "publish_local"
      }),
      JSON.stringify({ actionId: 21, kind: "refresh_remote" })
    ];
    mockNextCandidateExchangeAction.mockImplementation(() => {
      const action = actions.shift();
      if (action) return Promise.resolve(action);
      return new Promise<string>((_resolve, reject) => {
        pendingCandidateActionRejects.push(reject);
      });
    });
    mockConnectLink.mockResolvedValue("local_subnet");
    let publicationPending = false;

    await expect(
      connectTrickledDeviceLink({
        attempt: initialAttempt,
        bindRemoteCandidateWake: () => jest.fn(),
        deadline: Date.now() + 30_000,
        ensureCurrent: () => undefined,
        fetchRemote: async () => {
          expect(publicationPending).toBe(true);
          return readyAttempt;
        },
        local: {
          candidates: [],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        publishLocal: (_description, signal) =>
          new Promise((_resolve, reject) => {
            publicationPending = true;
            const abort = new Error("publication cancelled");
            abort.name = "AbortError";
            signal.addEventListener(
              "abort",
              () => {
                publicationPending = false;
                reject(abort);
              },
              { once: true }
            );
          }),
        record: () => undefined,
        signal: new AbortController().signal,
        token: 13
      })
    ).resolves.toBe("local_subnet");

    expect(mockConnectLink).toHaveBeenCalledTimes(1);
    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      21,
      true,
      false,
      "[]",
      13
    );
    expect(publicationPending).toBe(false);
  });

  it("accepts an authoritative publication response older than a concurrent ready refresh", async () => {
    const initialAttempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      state: "awaiting_owner" as const
    };
    const publishedAttempt = {
      ...initialAttempt,
      callerIce: {
        ...initialAttempt.callerIce,
        candidates: ["candidate:caller"]
      }
    };
    const readyAttempt = {
      ...initialAttempt,
      ownerFingerprint: "owner-fingerprint",
      ownerIce: { candidates: [], pwd: "owner-pwd", ufrag: "owner-ufrag" },
      state: "ready" as const
    };
    const actions = [
      JSON.stringify({
        actionId: 30,
        description: {
          candidates: ["candidate:caller"],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        kind: "publish_local"
      }),
      JSON.stringify({ actionId: 31, kind: "refresh_remote" })
    ];
    mockNextCandidateExchangeAction.mockImplementation(() => {
      const action = actions.shift();
      if (action) return Promise.resolve(action);
      return new Promise<string>((_resolve, reject) => {
        pendingCandidateActionRejects.push(reject);
      });
    });
    let resolvePublication!: (attempt: typeof publishedAttempt) => void;
    let resolveConnect!: (scope: string) => void;
    mockConnectLink.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      })
    );

    const connection = connectTrickledDeviceLink({
      attempt: initialAttempt,
      bindRemoteCandidateWake: () => jest.fn(),
      deadline: Date.now() + 30_000,
      ensureCurrent: () => undefined,
      fetchRemote: async () => readyAttempt,
      local: {
        candidates: [],
        fingerprint: "caller-fingerprint",
        pwd: "caller-pwd",
        ufrag: "caller-ufrag"
      },
      publishLocal: () =>
        new Promise((resolve) => {
          resolvePublication = resolve;
        }),
      record: () => undefined,
      signal: new AbortController().signal,
      token: 14
    });
    for (
      let attempt = 0;
      attempt < 20 && !mockConnectLink.mock.calls.length;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockConnectLink).toHaveBeenCalledTimes(1);

    resolvePublication(publishedAttempt);
    for (
      let attempt = 0;
      attempt < 20 &&
      !mockResolveCandidateExchangeAction.mock.calls.some(
        ([actionId]) => actionId === 30
      );
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    resolveConnect("local_subnet");
    await expect(connection).resolves.toBe("local_subnet");

    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      30,
      true,
      false,
      "[]",
      14
    );
  });

  it("cancels and joins native connect after a terminal remote identity change", async () => {
    mockNextCandidateExchangeAction.mockResolvedValueOnce(
      JSON.stringify({
        actionId: 1,
        kind: "refresh_remote"
      })
    );
    let rejectConnect!: (error: Error) => void;
    mockConnectLink.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      })
    );
    mockCancelLink.mockImplementation(async () => {
      rejectConnect(new Error("native connect cancelled"));
    });
    const attempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ownerFingerprint: "owner-fingerprint",
      ownerIce: { candidates: [], pwd: "owner-pwd", ufrag: "owner-ufrag" },
      state: "ready" as const
    };

    await expect(
      connectTrickledDeviceLink({
        attempt,
        bindRemoteCandidateWake: () => jest.fn(),
        deadline: Date.now() + 30_000,
        ensureCurrent: () => undefined,
        fetchRemote: async () => ({
          ...attempt,
          ownerFingerprint: "changed-owner-fingerprint"
        }),
        local: {
          candidates: [],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        publishLocal: async () => attempt,
        record: () => undefined,
        signal: new AbortController().signal,
        token: 9
      })
    ).rejects.toThrow("remote participant changed");

    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      1,
      false,
      false,
      "[]",
      9
    );
    expect(mockStopCandidateExchange).toHaveBeenCalledWith(9);
    expect(mockCancelLink).toHaveBeenCalledWith(9);
  });

  it("does not acknowledge a local publication missing from the authoritative attempt", async () => {
    const attempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ownerFingerprint: "owner-fingerprint",
      ownerIce: { candidates: [], pwd: "owner-pwd", ufrag: "owner-ufrag" },
      state: "ready" as const
    };
    mockNextCandidateExchangeAction.mockResolvedValueOnce(
      JSON.stringify({
        actionId: 7,
        description: {
          candidates: ["candidate:caller"],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        kind: "publish_local"
      })
    );
    let rejectConnect!: (error: Error) => void;
    mockConnectLink.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      })
    );
    mockCancelLink.mockImplementation(async () => {
      rejectConnect(new Error("native connect cancelled"));
    });

    await expect(
      connectTrickledDeviceLink({
        attempt,
        bindRemoteCandidateWake: () => jest.fn(),
        deadline: Date.now() + 30_000,
        ensureCurrent: () => undefined,
        fetchRemote: async () => attempt,
        local: {
          candidates: [],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        publishLocal: async () => attempt,
        record: () => undefined,
        signal: new AbortController().signal,
        token: 10
      })
    ).rejects.toThrow("candidate publication was not authoritative");

    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      7,
      false,
      false,
      "[]",
      10
    );
    expect(mockResolveCandidateExchangeAction).not.toHaveBeenCalledWith(
      7,
      true,
      expect.any(Boolean),
      expect.any(String),
      10
    );
  });

  it("closes the native candidate lifecycle when the initial attempt is not authoritative", async () => {
    const attempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      state: "awaiting_owner" as const
    };

    await expect(
      connectTrickledDeviceLink({
        attempt,
        bindRemoteCandidateWake: () => jest.fn(),
        deadline: Date.parse(attempt.expiresAt),
        ensureCurrent: () => undefined,
        fetchRemote: async () => attempt,
        local: {
          candidates: ["candidate:caller"],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        publishLocal: async () => attempt,
        record: () => undefined,
        signal: new AbortController().signal,
        token: 12
      })
    ).rejects.toThrow("candidate publication was not authoritative");

    expect(mockNotifyRemoteCandidateChange).not.toHaveBeenCalled();
    expect(mockStopCandidateExchange).toHaveBeenCalledWith(12);
    expect(mockCancelLink).toHaveBeenCalledWith(12);
  });

  it("cancels promptly while the initial candidate refresh notification is pending", async () => {
    const attempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      state: "awaiting_owner" as const
    };
    const controller = new AbortController();
    mockNotifyRemoteCandidateChange.mockImplementation(
      () => new Promise<void>(() => undefined)
    );

    const connection = connectTrickledDeviceLink({
      attempt,
      bindRemoteCandidateWake: () => jest.fn(),
      deadline: Date.parse(attempt.expiresAt),
      ensureCurrent: () => undefined,
      fetchRemote: async () => attempt,
      local: {
        candidates: [],
        fingerprint: "caller-fingerprint",
        pwd: "caller-pwd",
        ufrag: "caller-ufrag"
      },
      publishLocal: async () => attempt,
      record: () => undefined,
      signal: controller.signal,
      token: 15
    });
    controller.abort();

    await expect(connection).rejects.toThrow(
      "device-link connection race was cancelled"
    );
    expect(mockStopCandidateExchange).toHaveBeenCalledWith(15);
    expect(mockCancelLink).toHaveBeenCalledWith(15);
  });

  it("expires promptly while the initial candidate refresh notification is pending", async () => {
    const attempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      state: "awaiting_owner" as const
    };
    mockNotifyRemoteCandidateChange.mockImplementation(
      () => new Promise<void>(() => undefined)
    );

    await expect(
      connectTrickledDeviceLink({
        attempt,
        bindRemoteCandidateWake: () => jest.fn(),
        deadline: Date.now(),
        ensureCurrent: () => undefined,
        fetchRemote: async () => attempt,
        local: {
          candidates: [],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        publishLocal: async () => attempt,
        record: () => undefined,
        signal: new AbortController().signal,
        token: 16
      })
    ).rejects.toThrow("device-link attempt expired");
    expect(mockStopCandidateExchange).toHaveBeenCalledWith(16);
    expect(mockCancelLink).toHaveBeenCalledWith(16);
  });

  it("does not resolve a candidate action twice when native resolution fails", async () => {
    const attempt = {
      attemptId: "attempt-1",
      callerFingerprint: "caller-fingerprint",
      callerIce: { candidates: [], pwd: "caller-pwd", ufrag: "caller-ufrag" },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ownerFingerprint: "owner-fingerprint",
      ownerIce: { candidates: [], pwd: "owner-pwd", ufrag: "owner-ufrag" },
      state: "ready" as const
    };
    const published = {
      ...attempt,
      callerIce: {
        ...attempt.callerIce,
        candidates: ["candidate:caller"]
      }
    };
    mockNextCandidateExchangeAction.mockResolvedValueOnce(
      JSON.stringify({
        actionId: 8,
        description: {
          candidates: ["candidate:caller"],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        kind: "publish_local"
      })
    );
    mockResolveCandidateExchangeAction.mockRejectedValueOnce(
      new Error("native action resolution failed")
    );
    let rejectConnect!: (error: Error) => void;
    mockConnectLink.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      })
    );
    mockCancelLink.mockImplementation(async () => {
      rejectConnect(new Error("native connect cancelled"));
    });

    await expect(
      connectTrickledDeviceLink({
        attempt,
        bindRemoteCandidateWake: () => jest.fn(),
        deadline: Date.now() + 30_000,
        ensureCurrent: () => undefined,
        fetchRemote: async () => attempt,
        local: {
          candidates: [],
          fingerprint: "caller-fingerprint",
          pwd: "caller-pwd",
          ufrag: "caller-ufrag"
        },
        publishLocal: async () => published,
        record: () => undefined,
        signal: new AbortController().signal,
        token: 11
      })
    ).rejects.toThrow("native action resolution failed");

    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledTimes(1);
    expect(mockResolveCandidateExchangeAction).toHaveBeenCalledWith(
      8,
      true,
      false,
      "[]",
      11
    );
  });
});

describe("parsePairingQR", () => {
  it("accepts the canonical version one payload", () => {
    const secret = "a".repeat(43);
    expect(
      parsePairingQR(
        JSON.stringify({
          challengeId: "challenge-1",
          secret,
          version: 1
        })
      )
    ).toEqual({
      challengeId: "challenge-1",
      secret,
      version: 1
    });
  });

  it.each([
    "{}",
    '{"version":2,"challengeId":"challenge-1","secret":"x"}',
    '{"version":1,"challengeId":"","secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    '{"version":1,"challengeId":"challenge-1","secret":"not canonical"}'
  ])("rejects an invalid payload: %s", (payload) => {
    expect(() => parsePairingQR(payload)).toThrow("invalid pairing QR payload");
  });
});

describe("pairing proofs", () => {
  it("uses the server canonical byte layout", () => {
    expect(identityProof(" device-1 ", "public-key")).toBe(
      "tutti-device-identity/1\nregister\ndevice-1\ned25519\npublic-key"
    );
    expect(pairingClaimProof(" challenge-1 ", "secret")).toBe(
      "tutti-device-pairing/1\nclaim\nchallenge-1\nsecret"
    );
    expect(deviceLinkProof("create", " pairing-1 ", "", " fingerprint ")).toBe(
      "tutti-device-link/1\ncreate\npairing-1\n\nfingerprint"
    );
    expect(deviceLinkProof("get", "pairing-1", "attempt-1", "")).toBe(
      "tutti-device-link/1\nget\npairing-1\nattempt-1\n"
    );
    expect(deviceLinkProof("relay", "pairing-1", "", "")).toBe(
      "tutti-device-link/1\nrelay\npairing-1\n\n"
    );
    expect(standardBase64ToURL("a+b/c==")).toBe("a-b_c");
  });
});
