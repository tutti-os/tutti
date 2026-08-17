/**
 * Whether a recorded stimulus must wait for session-idle before dispatch.
 * Product-neutral; keep transport retry policy in the product runner for now.
 */
export function replayStimulusPrecondition(stimulus) {
  return stimulus.type === "session.send" &&
    stimulus.payload?.guidance !== true &&
    stimulus.payload?.guidance !== "steer"
    ? "session-idle"
    : null;
}

/**
 * Reject direct session.send stimuli that duplicate an engine intent
 * correlation already present on the tape.
 */
export function assertNoDuplicateEngineSends(activityEvents) {
  const engineCorrelations = new Set(
    activityEvents
      .filter((event) => event.kind === "intent")
      .map((event) => event.correlationId)
      .filter((correlationID) => typeof correlationID === "string")
  );
  const duplicate = activityEvents.find(
    (event) =>
      event.kind === "direct-stimulus" &&
      event.type === "session.send" &&
      typeof event.correlationId === "string" &&
      engineCorrelations.has(event.correlationId)
  );
  if (duplicate) {
    throw new Error(
      `direct session.send duplicates renderer intent correlation ${duplicate.correlationId}`
    );
  }
}

/**
 * Build HTTP path + body for a direct stimulus. Products differ only by the
 * workspace scope segment (`workspaces` for Tutti, `rooms` for TSH).
 *
 * @param {object} stimulus
 * @param {{ workspaceScopeSegment?: "workspaces" | "rooms" | string }} [options]
 */
export function replayStimulusRequest(
  stimulus,
  { workspaceScopeSegment = "workspaces" } = {}
) {
  const scope = String(workspaceScopeSegment ?? "").trim();
  if (!scope) {
    throw new Error("replayStimulusRequest requires workspaceScopeSegment");
  }
  const workspace = encodeURIComponent(stimulus.workspaceId);
  const session = encodeURIComponent(stimulus.agentSessionId);
  const base = `/v1/${scope}/${workspace}/agent-sessions`;
  switch (stimulus.type) {
    case "session.create": {
      const { content, displayPrompt, ...payload } = stimulus.payload;
      return {
        path: base,
        body: {
          ...payload,
          agentSessionId: stimulus.agentSessionId,
          initialContent: content,
          initialDisplayPrompt: displayPrompt
        }
      };
    }
    case "session.send":
      return {
        path: `${base}/${session}/input`,
        body: stimulus.payload
      };
    case "turn.cancel":
      return {
        path: `${base}/${session}/turns/${encodeURIComponent(stimulus.payload.turnId)}/cancel`
      };
    case "interactive.response":
      return {
        path: `${base}/${session}/interactives/${encodeURIComponent(stimulus.payload.requestId)}/response`,
        body: {
          turnId: stimulus.payload.turnId,
          action: stimulus.payload.action,
          optionId: stimulus.payload.optionId,
          payload: stimulus.payload.payload
        }
      };
    case "plan.decision":
      return {
        path: `${base}/${session}/turns/${encodeURIComponent(stimulus.payload.turnId)}/plan-decisions/${encodeURIComponent(stimulus.payload.requestId)}`,
        body: {
          promptKind: stimulus.payload.promptKind,
          action: stimulus.payload.action,
          idempotencyKey: stimulus.payload.idempotencyKey
        }
      };
    case "goal.control":
      return {
        path: `${base}/${session}/goal`,
        body: {
          action: stimulus.payload.action,
          ...(stimulus.payload.clientSubmitId
            ? { clientSubmitId: stimulus.payload.clientSubmitId }
            : {}),
          objective: stimulus.payload.objective
        }
      };
    case "session.settings.update":
      return {
        path: `${base}/${session}/settings`,
        body: stimulus.payload.settings
      };
    default:
      return null;
  }
}
