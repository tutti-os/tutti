import { deviceLink } from "../native/mobileNative";

export interface DeviceLinkICE {
  candidates: string[];
  pwd: string;
  ufrag: string;
}

export interface DeviceLinkDescription extends DeviceLinkICE {
  fingerprint: string;
}

export interface DeviceLinkAttempt {
  attemptId: string;
  callerFingerprint: string;
  callerIce: DeviceLinkICE;
  expiresAt: string;
  ownerFingerprint?: string;
  ownerIce?: DeviceLinkICE;
  state: "awaiting_owner" | "ready";
  stunEndpoints?: string[];
}

export type DeviceLinkCandidateStage =
  | "direct_attempt_ready"
  | "direct_first_candidate_published"
  | "direct_remote_candidate_received";

type DeviceLinkCandidateAction =
  | {
      actionId: number;
      description: DeviceLinkDescription;
      kind: "publish_local";
    }
  | {
      actionId: number;
      kind: "refresh_remote";
    };

interface TrickleConnectionOptions {
  attempt: DeviceLinkAttempt;
  bindRemoteCandidateWake(attemptId: string, token: number): () => void;
  deadline: number;
  ensureCurrent(): void;
  fetchRemote(signal: AbortSignal): Promise<DeviceLinkAttempt>;
  local: DeviceLinkDescription;
  publishLocal(
    description: DeviceLinkDescription,
    signal: AbortSignal
  ): Promise<DeviceLinkAttempt>;
  record(stage: DeviceLinkCandidateStage): void;
  signal: AbortSignal;
  token: number;
}

interface CandidateMetrics {
  localPublished: boolean;
  remoteReceived: boolean;
}

// Go owns candidate worker scheduling, retry delay, push/poll reconciliation,
// and stop ordering. Two identical drainers service the Go local and remote
// workers concurrently; each worker still has at most one unresolved action.
// This adapter supplies only Tutti's signed, authoritative rendezvous I/O.
export async function connectTrickledDeviceLink(
  options: TrickleConnectionOptions
): Promise<string> {
  let unbindRemoteCandidateWake: () => void = () => undefined;
  let connectedPeer: DeviceLinkDescription | undefined;
  let connectTask: Promise<string> | undefined;
  let candidateWorkerTasks: Promise<never>[] = [];
  let connected = false;
  const metrics: CandidateMetrics = {
    localPublished: false,
    remoteReceived: false
  };
  const actionIO = new AbortController();
  const abortActionIO = () => actionIO.abort();
  let actionIOBound = false;
  let cancellation: ReturnType<typeof cancellationFailure> | undefined;
  let expiry: ReturnType<typeof deadlineFailure> | undefined;
  try {
    options.ensureCurrent();
    if (options.signal.aborted) {
      throw new Error("device-link connection race was cancelled");
    }
    const attemptId = options.attempt.attemptId;
    if (!attemptId.trim()) {
      throw new Error("device-link attempt identity is missing");
    }
    const expectedCaller = parseDeviceLinkDescription(
      JSON.stringify(options.local)
    );
    let attempt = validateAuthoritativeAttempt(
      options.attempt,
      attemptId,
      expectedCaller,
      expectedCaller
    );
    if (!Number.isFinite(options.deadline)) {
      throw new Error("device-link attempt expiry is invalid");
    }
    options.signal.addEventListener("abort", abortActionIO, { once: true });
    actionIOBound = true;
    unbindRemoteCandidateWake = options.bindRemoteCandidateWake(
      attemptId,
      options.token
    );
    cancellation = cancellationFailure(options.signal);
    expiry = deadlineFailure(options.deadline);
    const terminal = Promise.race([cancellation.promise, expiry.promise]);
    // Close the event-before-bind gap with one immediate authoritative refresh.
    await Promise.race([
      deviceLink.notifyRemoteCandidateChange(options.token),
      terminal
    ]);
    options.ensureCurrent();
    if (options.signal.aborted) {
      throw new Error("device-link connection race was cancelled");
    }
    if (Date.now() >= options.deadline) {
      throw new Error("device-link attempt expired");
    }
    let resolveConnection: (scope: string) => void = () => undefined;
    let rejectConnection: (error: unknown) => void = () => undefined;
    const connection = new Promise<string>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    const startConnectIfReady = () => {
      if (!connectTask && attempt.state === "ready") {
        connectedPeer = remoteDescription(attempt);
        options.record("direct_attempt_ready");
        connectTask = deviceLink.connectLink(
          JSON.stringify(connectedPeer),
          true,
          options.token,
          30_000
        );
        void connectTask.then(resolveConnection, rejectConnection);
      }
    };
    const observeRemoteAttempt = (refreshed: DeviceLinkAttempt) => {
      attempt = refreshed;
      startConnectIfReady();
    };
    startConnectIfReady();
    candidateWorkerTasks = Array.from({ length: 2 }, () =>
      drainCandidateActions(
        attemptId,
        expectedCaller,
        () => connectedPeer,
        metrics,
        options,
        actionIO.signal,
        observeRemoteAttempt
      )
    );
    const scope = await Promise.race([
      connection,
      terminal,
      ...candidateWorkerTasks
    ]);
    connected = true;
    return scope;
  } finally {
    unbindRemoteCandidateWake();
    cancellation?.dispose();
    expiry?.dispose();
    if (actionIOBound) {
      options.signal.removeEventListener("abort", abortActionIO);
    }
    actionIO.abort();
    await deviceLink
      .stopCandidateExchange(options.token)
      .catch(() => undefined);
    if (!connected) {
      await deviceLink.cancelLink(options.token).catch(() => undefined);
    }
    const tasks: Promise<unknown>[] = [];
    tasks.push(...candidateWorkerTasks);
    if (connectTask) tasks.push(connectTask);
    await Promise.allSettled(tasks);
  }
}

export function parseDeviceLinkDescription(raw: string): DeviceLinkDescription {
  const parsed = JSON.parse(raw) as Partial<DeviceLinkDescription>;
  if (
    typeof parsed.fingerprint !== "string" ||
    parsed.fingerprint.length === 0 ||
    typeof parsed.ufrag !== "string" ||
    parsed.ufrag.length === 0 ||
    typeof parsed.pwd !== "string" ||
    parsed.pwd.length === 0 ||
    !Array.isArray(parsed.candidates) ||
    !parsed.candidates.every((candidate) => typeof candidate === "string")
  ) {
    throw new Error("invalid local DeviceLink description");
  }
  return {
    candidates: parsed.candidates,
    fingerprint: parsed.fingerprint,
    pwd: parsed.pwd,
    ufrag: parsed.ufrag
  };
}

async function drainCandidateActions(
  attemptId: string,
  expectedCaller: DeviceLinkDescription,
  connectedPeer: () => DeviceLinkDescription | undefined,
  metrics: CandidateMetrics,
  options: TrickleConnectionOptions,
  signal: AbortSignal,
  observeRemoteAttempt: (attempt: DeviceLinkAttempt) => void
): Promise<never> {
  while (true) {
    const timeoutMillis = Math.max(1, Math.ceil(options.deadline - Date.now()));
    const action = parseCandidateExchangeAction(
      await deviceLink.nextCandidateExchangeAction(options.token, timeoutMillis)
    );
    const refreshed = await executeCandidateAction(
      action,
      attemptId,
      expectedCaller,
      connectedPeer,
      metrics,
      options,
      signal
    );
    if (refreshed) observeRemoteAttempt(refreshed);
  }
}

async function executeCandidateAction(
  action: DeviceLinkCandidateAction,
  attemptId: string,
  expectedCaller: DeviceLinkDescription,
  connectedPeer: () => DeviceLinkDescription | undefined,
  metrics: CandidateMetrics,
  options: TrickleConnectionOptions,
  signal: AbortSignal
): Promise<DeviceLinkAttempt | undefined> {
  if (action.kind === "publish_local") {
    try {
      validateAuthoritativeAttempt(
        await options.publishLocal(action.description, signal),
        attemptId,
        expectedCaller,
        action.description
      );
    } catch (error) {
      return resolveCandidateActionFailure(action, error, options);
    }
    await deviceLink.resolveCandidateExchangeAction(
      action.actionId,
      true,
      false,
      "[]",
      options.token
    );
    if (!metrics.localPublished) {
      metrics.localPublished = true;
      options.record("direct_first_candidate_published");
    }
    return undefined;
  }

  let refreshed: DeviceLinkAttempt;
  let candidates: string[];
  try {
    refreshed = validateAuthoritativeAttempt(
      await options.fetchRemote(signal),
      attemptId,
      expectedCaller,
      undefined,
      connectedPeer()
    );
    candidates =
      refreshed.state === "ready"
        ? remoteDescription(refreshed).candidates
        : [];
  } catch (error) {
    return resolveCandidateActionFailure(action, error, options);
  }
  const added = await deviceLink.resolveCandidateExchangeAction(
    action.actionId,
    true,
    false,
    JSON.stringify(candidates),
    options.token
  );
  if (added > 0 && !metrics.remoteReceived) {
    metrics.remoteReceived = true;
    options.record("direct_remote_candidate_received");
  }
  return refreshed;
}

async function resolveCandidateActionFailure(
  action: DeviceLinkCandidateAction,
  error: unknown,
  options: TrickleConnectionOptions
): Promise<undefined> {
  options.ensureCurrent();
  const retryable = isRetryableCandidateExchangeError(error);
  await deviceLink.resolveCandidateExchangeAction(
    action.actionId,
    false,
    retryable,
    "[]",
    options.token
  );
  if (!retryable) throw error;
  return undefined;
}

function callerDescription(attempt: DeviceLinkAttempt): DeviceLinkDescription {
  const callerIce = attempt.callerIce as DeviceLinkICE | null | undefined;
  if (!callerIce) {
    throw new Error("device-link caller participant is incomplete");
  }
  return parseDeviceLinkDescription(
    JSON.stringify({
      candidates: callerIce.candidates ?? [],
      fingerprint: attempt.callerFingerprint,
      pwd: callerIce.pwd,
      ufrag: callerIce.ufrag
    })
  );
}

function validateAuthoritativeAttempt(
  candidate: DeviceLinkAttempt,
  expectedAttemptId: string,
  expectedCaller: DeviceLinkDescription,
  published?: DeviceLinkDescription,
  connectedPeer?: DeviceLinkDescription
): DeviceLinkAttempt {
  if (!candidate || candidate.attemptId !== expectedAttemptId) {
    throw new Error("device-link authoritative attempt identity changed");
  }
  if (candidate.state !== "awaiting_owner" && candidate.state !== "ready") {
    throw new Error("device-link authoritative attempt state is invalid");
  }
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) {
    throw new Error("device-link authoritative attempt expiry is invalid");
  }
  const caller = callerDescription(candidate);
  if (
    published &&
    (published.fingerprint !== expectedCaller.fingerprint ||
      published.ufrag !== expectedCaller.ufrag ||
      published.pwd !== expectedCaller.pwd)
  ) {
    throw new Error("device-link local participant changed");
  }
  if (
    caller.fingerprint !== expectedCaller.fingerprint ||
    caller.ufrag !== expectedCaller.ufrag ||
    caller.pwd !== expectedCaller.pwd
  ) {
    throw new Error("device-link caller participant changed");
  }
  if (
    published &&
    !published.candidates.every((value) => caller.candidates.includes(value))
  ) {
    throw new Error("device-link candidate publication was not authoritative");
  }
  const normalized: DeviceLinkAttempt = {
    ...candidate,
    callerIce: { ...candidate.callerIce, candidates: caller.candidates }
  };
  if (connectedPeer) {
    const peer = remoteDescription(normalized);
    if (
      peer.fingerprint !== connectedPeer.fingerprint ||
      peer.ufrag !== connectedPeer.ufrag ||
      peer.pwd !== connectedPeer.pwd
    ) {
      throw new Error(
        "device-link remote participant changed while connecting"
      );
    }
  }
  return normalized;
}

function remoteDescription(attempt: DeviceLinkAttempt): DeviceLinkDescription {
  const ownerIce = attempt.ownerIce as DeviceLinkICE | null | undefined;
  if (
    attempt.state !== "ready" ||
    !ownerIce ||
    typeof attempt.ownerFingerprint !== "string" ||
    attempt.ownerFingerprint.length === 0 ||
    typeof ownerIce.ufrag !== "string" ||
    ownerIce.ufrag.length === 0 ||
    typeof ownerIce.pwd !== "string" ||
    ownerIce.pwd.length === 0 ||
    (ownerIce.candidates !== null &&
      (!Array.isArray(ownerIce.candidates) ||
        !ownerIce.candidates.every(
          (candidate) => typeof candidate === "string"
        )))
  ) {
    throw new Error("device-link remote participant is not ready");
  }
  return {
    candidates: ownerIce.candidates ?? [],
    fingerprint: attempt.ownerFingerprint,
    pwd: ownerIce.pwd,
    ufrag: ownerIce.ufrag
  };
}

function parseCandidateExchangeAction(raw: string): DeviceLinkCandidateAction {
  const parsed = JSON.parse(raw) as {
    actionId?: unknown;
    description?: unknown;
    kind?: unknown;
  };
  if (
    typeof parsed.actionId !== "number" ||
    !Number.isSafeInteger(parsed.actionId) ||
    parsed.actionId <= 0
  ) {
    throw new Error("invalid DeviceLink candidate action identity");
  }
  if (parsed.kind === "refresh_remote") {
    return { actionId: parsed.actionId, kind: parsed.kind };
  }
  if (parsed.kind === "publish_local") {
    return {
      actionId: parsed.actionId,
      description: parseDeviceLinkDescription(
        JSON.stringify(parsed.description)
      ),
      kind: parsed.kind
    };
  }
  throw new Error("invalid DeviceLink candidate action kind");
}

function isRetryableCandidateExchangeError(error: unknown): boolean {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function cancellationFailure(signal: AbortSignal): {
  dispose(): void;
  promise: Promise<never>;
} {
  let rejectCancellation: (reason: Error) => void = () => undefined;
  const onAbort = () =>
    rejectCancellation(new Error("device-link connection race was cancelled"));
  const promise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    dispose: () => signal.removeEventListener("abort", onAbort),
    promise
  };
}

function deadlineFailure(deadline: number): {
  dispose(): void;
  promise: Promise<never>;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const delay = Math.max(0, deadline - Date.now());
    timer = setTimeout(
      () => reject(new Error("device-link attempt expired")),
      delay
    );
  });
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
    promise
  };
}
