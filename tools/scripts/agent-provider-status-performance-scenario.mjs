import {
  evaluate,
  finishRendererScenario,
  markRenderer,
  startRendererScenario,
  waitForProviderTiles
} from "./agent-gui-performance-helpers.mjs";
import { setTimeout as delay } from "node:timers/promises";

const markers = {
  start: "tutti-perf:provider-status-focus-refresh:start",
  firstFocusDispatched:
    "tutti-perf:provider-status-focus-refresh:first-focus-dispatched",
  secondFocusDispatched:
    "tutti-perf:provider-status-focus-refresh:second-focus-dispatched",
  observationCompleted:
    "tutti-perf:provider-status-focus-refresh:observation-completed",
  end: "tutti-perf:provider-status-focus-refresh:end"
};

export const providerStatusFocusRefreshScenario = {
  id: "provider-status-focus-refresh",
  markers,
  milestones: [
    {
      key: "firstFocusDispatched",
      label: "first focus dispatched",
      marker: markers.firstFocusDispatched
    },
    {
      key: "secondFocusDispatched",
      label: "second focus dispatched",
      marker: markers.secondFocusDispatched
    },
    {
      key: "observationCompleted",
      label: "focus observation completed",
      marker: markers.observationCompleted
    }
  ],
  prepare: prepareProviderStatusFocusRefresh,
  execute: executeProviderStatusFocusRefresh,
  describe(prepared) {
    return `${prepared.providerCount} visible providers; focus twice without requesting provider status`;
  },
  summarize(prepared, result) {
    return summarizeProviderStatusFocusRefresh(prepared, result);
  }
};

async function prepareProviderStatusFocusRefresh(context, options) {
  const { pageClient } = context;
  await pageClient.send("Page.enable");
  await pageClient.send("Network.enable");
  const networkRecorder = createProviderStatusNetworkRecorder(pageClient);
  const ownership = await evaluate(
    pageClient,
    `new URLSearchParams(location.search).get('reportPredefinePageview')`
  );
  if (ownership !== "1") {
    const loaded = pageClient.waitForEvent("Page.loadEventFired");
    await evaluate(
      pageClient,
      `(() => {
        const url = new URL(location.href);
        url.searchParams.set('reportPredefinePageview', '1');
        history.replaceState(null, '', url);
        return true;
      })()`
    );
    await pageClient.send("Page.reload");
    await loaded;
  }
  const providers = await waitForProviderTiles(pageClient, options.timeoutMs);
  await waitForRecordedRequests(
    networkRecorder,
    (requests) =>
      requests.length > 0 &&
      requests.every((request) => request.endedAt !== null),
    options.timeoutMs,
    "completed startup provider-status request"
  );
  await waitForNetworkQuiescence(networkRecorder, 2_500, options.timeoutMs);
  const startupRequestCount = networkRecorder.requests.length;
  networkRecorder.reset();
  return {
    networkRecorder,
    providerCount: providers.tiles.length,
    startupRequestCount
  };
}

async function executeProviderStatusFocusRefresh(context, prepared) {
  const { pageClient } = context;
  const recorder = prepared.networkRecorder;
  try {
    await startRendererScenario(pageClient, markers.start);
    await evaluate(
      pageClient,
      `(() => {
        window.dispatchEvent(new Event('focus'));
        console.timeStamp(${JSON.stringify(markers.firstFocusDispatched)});
        return true;
      })()`
    );
    await delay(100);
    await evaluate(
      pageClient,
      `(() => {
        window.dispatchEvent(new Event('focus'));
        console.timeStamp(${JSON.stringify(markers.secondFocusDispatched)});
        return true;
      })()`
    );
    await delay(1_000);
    await markRenderer(pageClient, markers.observationCompleted);
    await finishRendererScenario(pageClient, markers.end);
    return { requests: recorder.requests.map((request) => ({ ...request })) };
  } finally {
    recorder.dispose();
    await pageClient.send("Network.disable").catch(() => {});
  }
}

function createProviderStatusNetworkRecorder(pageClient) {
  const requests = [];
  const requestsByID = new Map();
  let lastActivityAt = Date.now();
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const disposables = [
    pageClient.subscribe("Network.requestWillBeSent", (event) => {
      const url = new URL(event.params.request.url);
      if (
        url.pathname !== "/v1/agent-providers/status" ||
        event.params.request.method !== "GET"
      ) {
        return;
      }
      markActivity();
      const record = {
        endedAt: null,
        error: null,
        ok: null,
        refresh: url.searchParams.get("refresh"),
        requestID: event.params.requestId,
        startedAt: event.params.timestamp * 1000,
        status: null,
        url: url.toString()
      };
      requests.push(record);
      requestsByID.set(record.requestID, record);
    }),
    pageClient.subscribe("Network.responseReceived", (event) => {
      const record = requestsByID.get(event.params.requestId);
      if (!record) return;
      markActivity();
      record.status = event.params.response.status;
      record.ok = record.status >= 200 && record.status < 300;
    }),
    pageClient.subscribe("Network.loadingFinished", (event) => {
      const record = requestsByID.get(event.params.requestId);
      if (record) {
        markActivity();
        record.endedAt = event.params.timestamp * 1000;
      }
    }),
    pageClient.subscribe("Network.loadingFailed", (event) => {
      const record = requestsByID.get(event.params.requestId);
      if (!record) return;
      markActivity();
      record.endedAt = event.params.timestamp * 1000;
      record.error = event.params.errorText;
      record.ok = false;
    })
  ];
  return {
    requests,
    getLastActivityAt: () => lastActivityAt,
    dispose() {
      for (const dispose of disposables) dispose();
    },
    reset() {
      requests.length = 0;
      requestsByID.clear();
      markActivity();
    }
  };
}

async function waitForRecordedRequests(recorder, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(recorder.requests)) return;
    await delay(50);
  }
  throw new Error(
    `timed out waiting for ${label}: ${JSON.stringify(recorder.requests)}`
  );
}

async function waitForNetworkQuiescence(recorder, quietPeriodMs, timeoutMs) {
  await waitForRecordedRequests(
    recorder,
    (requests) =>
      requests.length > 0 &&
      requests.every((request) => request.endedAt !== null) &&
      Date.now() - recorder.getLastActivityAt() >= quietPeriodMs,
    timeoutMs,
    `${quietPeriodMs} ms of provider-status startup quiescence`
  );
}

export function summarizeProviderStatusFocusRefresh(prepared, result) {
  const requests = result.requests ?? [];
  const durations = requests.map((request) =>
    request.endedAt === null
      ? "incomplete"
      : `${Math.round(request.endedAt - request.startedAt)} ms`
  );
  const assertions = [
    {
      name: "startup provider snapshot loaded before capture",
      passed: prepared.startupRequestCount > 0
    },
    {
      name: "focus uses the loaded renderer snapshot",
      passed: requests.length === 0
    },
    {
      name: "focus never forces provider detection",
      passed: requests.every((request) => request.refresh !== "true")
    }
  ];
  return {
    outcome: assertions.every((assertion) => assertion.passed)
      ? "passed"
      : "failed",
    assertions,
    details: [
      { label: "Visible providers", value: String(prepared.providerCount) },
      {
        label: "Startup requests drained before capture",
        value: String(prepared.startupRequestCount)
      },
      { label: "Focus-driven status requests", value: String(requests.length) },
      {
        label: "Unexpected request durations",
        value: durations.length > 0 ? durations.join(" → ") : "none"
      }
    ],
    stabilityCriterion:
      "two focus events observed for one second with no provider-status request"
  };
}
