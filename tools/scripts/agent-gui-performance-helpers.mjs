import { setTimeout as delay } from "node:timers/promises";

const conversationItemPrefix = "agent-gui-conversation-item-";

export async function evaluate(client, expression, awaitPromise = false) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "renderer evaluation failed";
    throw new Error(description);
  }
  return response.result?.value;
}

export async function waitForEvaluation(
  client,
  expression,
  timeoutMs,
  label,
  intervalMs = 250
) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await evaluate(client, expression);
    if (latest?.ready) return latest;
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

export async function markRenderer(client, marker) {
  await evaluate(client, `console.timeStamp(${JSON.stringify(marker)}); true`);
}

export async function startRendererScenario(client, marker) {
  await markRenderer(client, marker);
}

export async function finishRendererScenario(client, marker) {
  await evaluate(
    client,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      console.timeStamp(${JSON.stringify(marker)});
      resolve(true);
    }, 250))))`,
    true
  );
}

export async function waitForProviderTiles(client, timeoutMs) {
  return waitForEvaluation(
    client,
    `(() => {
      const elements = [...document.querySelectorAll('[data-provider-target-id]')];
      const tiles = elements.map((element) => ({
        targetID: element.dataset.providerTargetId ?? '',
        disabled: element.hasAttribute('disabled') || element.dataset.disabled === 'true'
      }));
      return {
        ready: tiles.filter((tile) => tile.targetID && !tile.disabled).length >= 2,
        tiles,
        selectedTargetID: elements.find((element) => element.dataset.selected === 'true')?.dataset.providerTargetId ?? null
      };
    })()`,
    timeoutMs,
    "provider rail with two enabled targets"
  );
}

export async function clickProviderTarget(client, targetID) {
  await evaluate(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(targetID)});
      if (!(target instanceof HTMLButtonElement)) throw new Error('provider target is unavailable');
      target.click();
      return true;
    })()`
  );
}

export async function waitForSelectedTarget(client, targetID, timeoutMs) {
  return waitForEvaluation(
    client,
    `(() => {
      const target = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(targetID)});
      return { ready: target?.dataset.selected === 'true' };
    })()`,
    timeoutMs,
    `selected Agent target ${targetID}`
  );
}

export async function selectProvider(client, targetID, timeoutMs) {
  await clickProviderTarget(client, targetID);
  await waitForSelectedTarget(client, targetID, timeoutMs);
  return waitForStableRail(client, targetID, timeoutMs);
}

export async function waitForStableRail(client, targetID, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previousSignature = null;
  let stablePolls = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readRail(client, targetID);
    const signature = JSON.stringify(latest);
    if (
      latest.selected &&
      latest.sectionCount > 0 &&
      latest.loadingCount === 0 &&
      signature === previousSignature
    ) {
      stablePolls += 1;
      if (stablePolls >= 5) return latest;
    } else {
      stablePolls = 0;
    }
    previousSignature = signature;
    await delay(200);
  }
  throw new Error(
    `timed out waiting for stable AgentGUI rail: ${JSON.stringify(latest)}`
  );
}

export async function waitForSessionItems(client, timeoutMs, minimum = 2) {
  return waitForEvaluation(
    client,
    `(() => {
      const rows = [...document.querySelectorAll('[data-testid^=${JSON.stringify(conversationItemPrefix)}]')];
      const items = rows.map((row) => ({
        id: row.dataset.testid?.slice(${conversationItemPrefix.length}) ?? '',
        active: row.dataset.active === 'true'
      })).filter((item) => item.id);
      return {
        ready: items.length >= ${minimum},
        items,
        activeSessionID: items.find((item) => item.active)?.id ?? null
      };
    })()`,
    timeoutMs,
    `AgentGUI rail with ${minimum} sessions`
  );
}

export function selectSessionSwitchTargets(items, activeSessionID = null) {
  const ids = items.map((item) => item.id).filter(Boolean);
  if (ids.length < 2) {
    throw new Error("session-switch requires at least two visible sessions");
  }
  const sourceSessionID = ids.includes(activeSessionID)
    ? activeSessionID
    : ids[0];
  const targetSessionID = ids.find((id) => id !== sourceSessionID);
  return { sourceSessionID, targetSessionID };
}

export async function clickSession(client, sessionID) {
  await evaluate(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-testid="${conversationItemPrefix}${sessionID}"]`)});
      const button = row?.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error('session is unavailable');
      button.click();
      return true;
    })()`
  );
}

export async function waitForActiveSession(client, sessionID, timeoutMs) {
  return waitForEvaluation(
    client,
    `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-testid="${conversationItemPrefix}${sessionID}"]`)});
      return { ready: row?.dataset.active === 'true' };
    })()`,
    timeoutMs,
    `active Agent session ${sessionID}`
  );
}

export async function selectSession(client, sessionID, targetID, timeoutMs) {
  await clickSession(client, sessionID);
  await waitForActiveSession(client, sessionID, timeoutMs);
  return waitForStableRail(client, targetID, timeoutMs);
}

export async function readAgentWorkbenchWindow(client) {
  return evaluate(
    client,
    `(() => {
      const shell = [...document.querySelectorAll('[data-workbench-window-id]')]
        .find((element) => element.dataset.workbenchNodeTypeId === 'agent-gui');
      return shell ? {
        id: shell.dataset.workbenchWindowId ?? '',
        displayMode: shell.dataset.displayMode ?? '',
        minimizedMount: shell.dataset.minimizedMount ?? '',
        title: shell.querySelector('[data-agent-gui-workbench-header]')?.textContent?.trim() ?? ''
      } : null;
    })()`
  );
}

export async function waitForStableAgentWorkbenchWindow(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previousID = null;
  let stablePolls = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readAgentWorkbenchWindow(client);
    if (
      latest?.id &&
      latest.minimizedMount === "visible" &&
      latest.id === previousID
    ) {
      stablePolls += 1;
      if (stablePolls >= 5) return latest;
    } else {
      stablePolls = 0;
    }
    previousID = latest?.id ?? null;
    await delay(200);
  }
  throw new Error(
    `timed out waiting for stable AgentGUI Workbench window: ${JSON.stringify(latest)}`
  );
}

export async function waitForStableViewport(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stablePolls = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await evaluate(
      client,
      "({ height: window.innerHeight, width: window.innerWidth })"
    );
    const signature = `${latest.width}x${latest.height}`;
    if (signature === previous) {
      stablePolls += 1;
      if (stablePolls >= 5) return latest;
    } else {
      stablePolls = 0;
    }
    previous = signature;
    await delay(100);
  }
  throw new Error(
    `timed out waiting for stable viewport: ${JSON.stringify(latest)}`
  );
}

export async function waitForAgentWorkbenchWindow(
  client,
  timeoutMs,
  predicateExpression = "Boolean(windowState)",
  label = "AgentGUI Workbench window",
  nodeID = null
) {
  const nodePredicate = nodeID
    ? `element.dataset.workbenchWindowId === ${JSON.stringify(nodeID)}`
    : "element.dataset.workbenchNodeTypeId === 'agent-gui'";
  return waitForEvaluation(
    client,
    `(() => {
      const shell = [...document.querySelectorAll('[data-workbench-window-id]')]
        .find((element) => ${nodePredicate});
      const windowState = shell ? {
        id: shell.dataset.workbenchWindowId ?? '',
        displayMode: shell.dataset.displayMode ?? '',
        minimizedMount: shell.dataset.minimizedMount ?? ''
      } : null;
      return { ready: ${predicateExpression}, windowState };
    })()`,
    timeoutMs,
    label
  );
}

export async function clickAgentWindowControl(client, nodeID, testID) {
  await evaluate(
    client,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${nodeID}"]`)});
      const button = shell?.querySelector(${JSON.stringify(`[data-testid="${testID}"]`)});
      if (!(button instanceof HTMLButtonElement)) throw new Error('AgentGUI window control is unavailable');
      button.click();
      return true;
    })()`
  );
}

export function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readRail(client, targetID) {
  return evaluate(
    client,
    `(() => {
      const root = document.querySelector('#agent-gui-conversation-rail')?.parentElement ?? document;
      const selected = [...document.querySelectorAll('[data-provider-target-id]')]
        .find((element) => element.dataset.providerTargetId === ${JSON.stringify(targetID)})
        ?.dataset.selected === 'true';
      return {
        selected,
        sectionCount: root.querySelectorAll('section[data-kind]').length,
        itemCount: root.querySelectorAll('[data-testid^=${JSON.stringify(conversationItemPrefix)}]').length,
        loadingCount: root.querySelectorAll('[aria-busy="true"], [data-loading="true"]').length
      };
    })()`
  );
}
