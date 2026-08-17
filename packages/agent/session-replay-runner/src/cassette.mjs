import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertCassettePolicyShape } from "./cassette-policy.mjs";

export const portableReplayCWDToken = "${REPLAY_CWD}";

/**
 * Product-neutral Cassette verify / parse / blob helpers.
 *
 * Products bind a loaded policy (and optional ports) once via
 * `createCassetteHelpers`. TSH injects shared-agent prerequisite checks and
 * stricter manifest identity; Tutti enables realpath canonicalization for
 * portable `${REPLAY_CWD}` resolution.
 *
 * @param {object} policy
 * @param {{
 *   requireManifestIdentity?: boolean,
 *   validReplayPrerequisites?: (prerequisites: unknown, agentTargetId?: string) => boolean,
 *   canonicalizeResolvedPaths?: boolean
 * }} [options]
 */
export function createCassetteHelpers(policy, options = {}) {
  const boundPolicy = assertCassettePolicyShape(policy);
  const ports = normalizeCassettePorts(options);
  return {
    verifyCassette(directory) {
      return verifyCassette(directory, boundPolicy, ports);
    },
    parseActivityEvents(contents) {
      return parseActivityEvents(contents, boundPolicy);
    },
    materializeReplayWorkspaceBlobs(cassettes, stateDirectory) {
      return materializeReplayWorkspaceBlobs(
        cassettes,
        stateDirectory,
        boundPolicy
      );
    },
    replayActionFromManifest(
      manifest,
      activityEvents,
      workspaceId,
      replayCWD,
      actionOptions = {}
    ) {
      return replayActionFromManifest(
        manifest,
        activityEvents,
        workspaceId,
        replayCWD,
        boundPolicy,
        ports,
        actionOptions
      );
    },
    resolvePortableActivityEventPayload(event, replayCWD, composerDefaults) {
      return resolvePortableActivityEventPayload(
        event,
        replayCWD,
        composerDefaults,
        ports
      );
    },
    loadReplayTurnIdentityPlan(cassetteDirectory, mode) {
      return loadReplayTurnIdentityPlan(cassetteDirectory, mode, boundPolicy);
    },
    replayTurnIdentityPlan
  };
}

export function validComposerDefaultsPrerequisites(value) {
  const defaults = value?.composerDefaults;
  return [
    defaults?.model,
    defaults?.permissionModeId,
    defaults?.reasoningEffort,
    defaults?.speed
  ].every((setting) => typeof setting === "string" && setting.trim());
}

export async function verifyCassette(directory, policy, options = {}) {
  const boundPolicy = assertCassettePolicyShape(policy);
  const ports = normalizeCassettePorts(options);
  const blobManifestName = boundPolicy.files.blobManifest.path;
  const cassetteManifestName = boundPolicy.files.cassetteManifest.path;
  const initialStateName = boundPolicy.files.initialState.path;
  const maxCassetteBytes = boundPolicy.limits.maxCassetteBytes;

  const manifest = JSON.parse(
    await readFile(join(directory, cassetteManifestName), "utf8")
  );
  if (
    manifest.schemaVersion !== boundPolicy.schemaVersion ||
    manifest.stateFormat !== "tutti.agent-session-replay-state.v1" ||
    (ports.requireManifestIdentity &&
      (typeof manifest.id !== "string" ||
        !manifest.id.trim() ||
        typeof manifest.rootAgentSessionId !== "string" ||
        !manifest.rootAgentSessionId.trim())) ||
    Object.hasOwn(manifest, "scopeId") ||
    Object.hasOwn(manifest, "workspaceId") ||
    !ports.validReplayPrerequisites(
      manifest.replayPrerequisites,
      manifest.agentTargetId
    ) ||
    manifest.maxTotalBytes !== boundPolicy.limits.maxCassetteBytes ||
    !Array.isArray(manifest.files) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0
  ) {
    throw new Error("cassette manifest is invalid or unsupported");
  }
  const blobManifest = JSON.parse(
    await readFile(join(directory, blobManifestName), "utf8")
  );
  if (
    blobManifest.schemaVersion !== boundPolicy.blobManifestSchemaVersion ||
    !Array.isArray(blobManifest.blobs)
  ) {
    throw new Error("cassette blob manifest is invalid or unsupported");
  }
  const policyFiles = new Map(
    Object.values(boundPolicy.files)
      .filter((file) => file.inventory !== false)
      .map((file) => [file.path, file])
  );
  for (const blob of blobManifest.blobs) {
    const digest =
      typeof blob.sha256 === "string" ? blob.sha256.toLowerCase() : "";
    if (
      !/^[0-9a-f]{64}$/u.test(digest) ||
      !Number.isSafeInteger(blob.sizeBytes) ||
      blob.sizeBytes < 0 ||
      blob.sizeBytes > boundPolicy.limits.maxPortableBlobBytes
    ) {
      throw new Error(
        `cassette blob has invalid integrity evidence: ${digest}`
      );
    }
    policyFiles.set(`blobs/sha256/${digest}`, {
      path: `blobs/sha256/${digest}`,
      role: "referenced-blob"
    });
  }
  const expected = new Map();
  for (const file of manifest.files) {
    const path = typeof file.path === "string" ? file.path : "";
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === ".."
        ) ||
      expected.has(path)
    ) {
      throw new Error(`cassette manifest has invalid file path: ${path}`);
    }
    const policyFile = policyFiles.get(path);
    if (!policyFile || file.role !== policyFile.role) {
      throw new Error(`cassette contains unrelated file: ${path}`);
    }
    if (
      path === boundPolicy.files.providerFrames.path &&
      file.sizeBytes > boundPolicy.limits.maxProviderTapeBytes
    ) {
      throw new Error(`provider tape size limit exceeded: ${file.sizeBytes}`);
    }
    expected.set(path, file);
  }
  for (const file of Object.values(boundPolicy.files)) {
    if (file.required && !expected.has(file.path)) {
      throw new Error(`cassette is missing required file: ${file.path}`);
    }
  }
  if (manifest.mode === "continue-session" && !expected.has(initialStateName)) {
    throw new Error(`cassette is missing required file: ${initialStateName}`);
  }
  if (manifest.mode === "create-session" && expected.has(initialStateName)) {
    throw new Error(
      `create-session cassette must not contain: ${initialStateName}`
    );
  }
  if (!["create-session", "continue-session"].includes(manifest.mode)) {
    throw new Error(`cassette has unsupported mode: ${manifest.mode}`);
  }
  const actualPaths = await listCassetteFiles(directory);
  const allowedPaths = new Set([...expected.keys(), cassetteManifestName]);
  for (const path of actualPaths) {
    if (!allowedPaths.has(path)) {
      throw new Error(`cassette contains unrelated file: ${path}`);
    }
  }
  let totalBytes = 0;
  for (const [path, file] of expected) {
    if (!actualPaths.includes(path)) {
      throw new Error(`cassette is missing manifest file: ${path}`);
    }
    const actual = await hashFile(join(directory, ...path.split("/")));
    if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256) {
      throw new Error(`cassette file integrity mismatch: ${path}`);
    }
    totalBytes += actual.sizeBytes;
    if (totalBytes > maxCassetteBytes) {
      throw new Error(
        `cassette size limit exceeded: total=${totalBytes} limit=${maxCassetteBytes}`
      );
    }
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error(
      `cassette total size mismatch: actual=${totalBytes} manifest=${manifest.totalBytes}`
    );
  }
  return manifest;
}

export async function materializeReplayWorkspaceBlobs(
  cassettes,
  stateDirectory,
  policy
) {
  const boundPolicy = assertCassettePolicyShape(policy);
  const plannedByTarget = new Map();
  const plans = await Promise.all(
    cassettes.map((cassette) =>
      readCassetteBlobPlan(cassette.cassetteDirectory, boundPolicy)
    )
  );
  for (const plan of plans.flat()) {
    const existing = plannedByTarget.get(plan.targetKey);
    if (existing) {
      if (
        existing.sha256 !== plan.sha256 ||
        existing.sizeBytes !== plan.sizeBytes ||
        existing.mimeType !== plan.mimeType
      ) {
        throw new Error(
          `conflicting Replay Workspace blob target: ${plan.targetKey}`
        );
      }
      continue;
    }
    plannedByTarget.set(plan.targetKey, plan);
  }
  for (const plan of plannedByTarget.values()) {
    const destination =
      plan.kind === "agent-prompt-attachment"
        ? join(
            stateDirectory,
            "agent",
            "attachments",
            plan.agentSessionId,
            `${plan.attachmentId}${promptImageExtension(plan.mimeType)}`
          )
        : join(
            stateDirectory,
            "agent",
            "runs",
            plan.agentSessionId,
            "codex-home",
            ...plan.relativePath.split("/")
          );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, plan.data, { mode: 0o600 });
  }
}

export function replayActionFromManifest(
  manifest,
  activityEvents,
  workspaceId,
  replayCWD,
  policy,
  options = {},
  actionOptions = {}
) {
  const boundPolicy = assertCassettePolicyShape(policy);
  const ports = normalizeCassettePorts(options);
  if (
    manifest?.schemaVersion !== boundPolicy.schemaVersion ||
    Object.hasOwn(manifest, "scopeId") ||
    Object.hasOwn(manifest, "workspaceId") ||
    !["create-session", "continue-session"].includes(manifest.mode) ||
    !manifest.agentTargetId ||
    !manifest.rootAgentSessionId ||
    !ports.validReplayPrerequisites(
      manifest.replayPrerequisites,
      manifest.agentTargetId
    ) ||
    typeof workspaceId !== "string" ||
    !workspaceId.trim() ||
    typeof replayCWD !== "string" ||
    !replayCWD.trim()
  ) {
    throw new Error("cassette manifest is invalid or unsupported");
  }
  const prompts = activityEvents
    .filter((event) =>
      [
        "activation/requested",
        "session.create",
        "session.send",
        "submit/requested"
      ].includes(event.type)
    )
    .map((event) => stimulusPrompt(event.payload))
    .filter(Boolean);
  if (activityEvents.length === 0) {
    throw new Error("cassette has no replayable activity events");
  }
  const productActivityEvents = activityEvents.map((event) => ({
    ...event,
    payload: resolvePortableActivityEventPayload(
      event,
      replayCWD,
      actionOptions.applyComposerDefaults !== false &&
        manifest.mode === "create-session"
        ? manifest.replayPrerequisites.composerDefaults
        : null,
      ports
    ),
    scopeId: workspaceId.trim(),
    workspaceId: workspaceId.trim()
  }));
  return {
    type: manifest.mode,
    workspaceId: workspaceId.trim(),
    agentTargetId: manifest.agentTargetId,
    agentSessionId: manifest.rootAgentSessionId,
    prompts,
    expectedTokens: prompts.map(() => ""),
    activityEvents: productActivityEvents
  };
}

export function resolvePortableActivityEventPayload(
  event,
  replayCWD,
  composerDefaults,
  options = {}
) {
  const ports = normalizeCassettePorts(options);
  if (
    !["activation/requested", "session/activate", "session.create"].includes(
      event?.type
    ) ||
    !event.payload
  ) {
    return event?.payload;
  }
  const payload = structuredClone(event.payload);
  if (
    ["activation/requested", "session/activate", "session.create"].includes(
      event.type
    ) &&
    composerDefaults
  ) {
    payload.settings = {
      ...(payload.settings ?? {}),
      ...composerDefaults
    };
  }
  payload.cwd = resolvePortableReplayPath(payload.cwd, replayCWD, ports);
  if (payload.railPlacement) {
    payload.railPlacement.projectPath = resolvePortableReplayPath(
      payload.railPlacement.projectPath,
      replayCWD,
      ports
    );
    if (payload.railPlacement.sectionKey !== undefined) {
      payload.railPlacement.sectionKey = resolvePortableRailSectionKey(
        payload.railPlacement.sectionKey,
        replayCWD,
        ports
      );
    }
  }
  if (payload.railSectionKey !== undefined) {
    payload.railSectionKey = resolvePortableRailSectionKey(
      payload.railSectionKey,
      replayCWD,
      ports
    );
  }
  return payload;
}

export function parseActivityEvents(contents, policy) {
  const boundPolicy = assertCassettePolicyShape(policy);
  const events = parseJSONLines(contents);
  const eventKinds = new Map();
  for (const [position, event] of events.entries()) {
    const previous = events[position - 1];
    const eventID =
      typeof event?.eventId === "string" ? event.eventId.trim() : "";
    if (
      event?.schemaVersion !== boundPolicy.schemaVersion ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence !== position + 1 ||
      !["intent", "effect", "direct-stimulus"].includes(event.kind) ||
      typeof event.type !== "string" ||
      !event.type.trim() ||
      typeof event.eventId !== "string" ||
      !eventID ||
      eventKinds.has(eventID) ||
      Object.hasOwn(event, "scopeId") ||
      Object.hasOwn(event, "workspaceId") ||
      !Number.isSafeInteger(event.occurredAtUnixMs) ||
      event.occurredAtUnixMs <= 0 ||
      (previous !== undefined &&
        event.occurredAtUnixMs < previous.occurredAtUnixMs) ||
      (event.payload !== undefined &&
        (typeof event.payload !== "object" ||
          event.payload === null ||
          Array.isArray(event.payload)))
    ) {
      throw new Error(
        `cassette activity event ${event?.sequence ?? "unknown"} is invalid`
      );
    }
    if (
      event.kind === "effect" &&
      (typeof event.causedByEventId !== "string" ||
        eventKinds.get(event.causedByEventId.trim()) !== "intent" ||
        !event.payload ||
        !["succeeded", "failed", "timedOut"].includes(event.payload.outcome))
    ) {
      throw new Error(
        `cassette effect ${event.sequence} does not reference an earlier intent`
      );
    }
    if (event.kind !== "effect" && event.causedByEventId !== undefined) {
      throw new Error(
        `cassette activity event ${event.sequence} has an invalid cause`
      );
    }
    eventKinds.set(eventID, event.kind);
  }
  return events;
}

export async function loadReplayTurnIdentityPlan(
  cassetteDirectory,
  mode,
  policy
) {
  const boundPolicy = assertCassettePolicyShape(policy);
  const expectedState = JSON.parse(
    await readFile(
      join(cassetteDirectory, boundPolicy.files.expectedState.path),
      "utf8"
    )
  );
  const initialState =
    mode === "continue-session"
      ? JSON.parse(
          await readFile(
            join(cassetteDirectory, boundPolicy.files.initialState.path),
            "utf8"
          )
        )
      : null;
  return replayTurnIdentityPlan(expectedState, initialState);
}

export function replayTurnIdentityPlan(expectedState, initialState = null) {
  const expectedSessions = expectedState?.agent?.sessions;
  const initialSessions = new Map(
    (initialState?.agent?.sessions ?? []).map((session) => [
      session.id,
      new Set((session.turns ?? []).map((turn) => turn.id))
    ])
  );
  if (!Array.isArray(expectedSessions)) {
    throw new Error("expected replay state has no Agent Sessions");
  }
  return Object.fromEntries(
    expectedSessions.map((session) => {
      const initialTurnIds = initialSessions.get(session.id) ?? new Set();
      const recordedTurnIds = (session.turns ?? [])
        .map((turn) => turn.id)
        .filter((turnId) => !initialTurnIds.has(turnId));
      if (
        typeof session.id !== "string" ||
        recordedTurnIds.some(
          (turnId) => typeof turnId !== "string" || !turnId.trim()
        )
      ) {
        throw new Error("expected replay state has invalid Turn identities");
      }
      return [
        session.id,
        {
          initialTurnIds: [...initialTurnIds],
          recordedTurnIds,
          ...(session.kind === "child"
            ? {
                kind: "child",
                initialSession: initialSessions.has(session.id),
                rootSessionId: session.rootSessionId,
                rootTurnId: session.rootTurnId,
                parentSessionId: session.parentSessionId,
                parentTurnId: session.parentTurnId,
                parentToolCallId: session.parentToolCallId
              }
            : {})
        }
      ];
    })
  );
}

function normalizeCassettePorts(options = {}) {
  return {
    requireManifestIdentity: options.requireManifestIdentity === true,
    canonicalizeResolvedPaths: options.canonicalizeResolvedPaths === true,
    validReplayPrerequisites:
      typeof options.validReplayPrerequisites === "function"
        ? options.validReplayPrerequisites
        : (value) => validComposerDefaultsPrerequisites(value)
  };
}

function resolvePortableRailSectionKey(value, replayCWD, ports) {
  const prefix = "project:";
  if (typeof value !== "string" || !value.startsWith(prefix)) return value;
  return (
    prefix +
    resolvePortableReplayPath(value.slice(prefix.length), replayCWD, ports)
  );
}

function resolvePortableReplayPath(value, replayCWD, ports) {
  if (typeof value !== "string") return value;
  let resolved = value;
  let fromPortableToken = false;
  if (value === portableReplayCWDToken) {
    resolved = replayCWD;
    fromPortableToken = true;
  } else if (value.startsWith(`${portableReplayCWDToken}/`)) {
    resolved = join(
      replayCWD,
      ...value.slice(portableReplayCWDToken.length + 1).split("/")
    );
    fromPortableToken = true;
  }
  if (!ports.canonicalizeResolvedPaths) {
    return resolved;
  }
  if (
    typeof resolved !== "string" ||
    !resolved ||
    (!fromPortableToken && !resolved.startsWith("/"))
  ) {
    return resolved;
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function listCassetteFiles(root) {
  const result = [];
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        result.push(relative);
      } else {
        throw new Error(`cassette contains unsupported file: ${relative}`);
      }
    }
  }
  await visit(root, "");
  return result.sort();
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function readCassetteBlobPlan(cassetteDirectory, policy) {
  const blobManifestName = policy.files.blobManifest.path;
  const manifest = JSON.parse(
    await readFile(join(cassetteDirectory, blobManifestName), "utf8")
  );
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.blobs)) {
    throw new Error("cassette blob manifest is invalid");
  }
  const targets = new Set();
  const result = [];
  for (const entry of manifest.blobs) {
    validateBlobEntry(entry);
    const key =
      entry.kind === "agent-prompt-attachment"
        ? `${entry.kind}\0${entry.agentSessionId}\0${entry.attachmentId}`
        : `${entry.kind}\0${entry.agentSessionId}\0${entry.relativePath}`;
    if (targets.has(key)) {
      throw new Error(`duplicate cassette blob target: ${key}`);
    }
    targets.add(key);
    const source = join(cassetteDirectory, "blobs", "sha256", entry.sha256);
    const data = await readFile(source);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== entry.sha256 || data.byteLength !== entry.sizeBytes) {
      throw new Error(`cassette blob integrity mismatch: ${entry.sha256}`);
    }
    result.push({ ...entry, data, targetKey: key });
  }
  return result;
}

function validateBlobEntry(entry) {
  if (
    !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0 ||
    !safePathSegment(entry.agentSessionId) ||
    !promptImageExtension(entry.mimeType)
  ) {
    throw new Error("cassette blob entry is invalid or unsupported");
  }
  if (
    entry.kind === "agent-prompt-attachment" &&
    safePathSegment(entry.attachmentId) &&
    entry.relativePath === undefined
  ) {
    return;
  }
  if (
    entry.kind === "agent-generated-image" &&
    entry.attachmentId === undefined &&
    safeGeneratedImageRelativePath(entry.relativePath) &&
    entry.relativePath.endsWith(promptImageExtension(entry.mimeType))
  ) {
    return;
  }
  throw new Error("cassette blob entry is invalid or unsupported");
}

function safePathSegment(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function safeGeneratedImageRelativePath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("generated_images/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== ".."
      )
  );
}

function promptImageExtension(mimeType) {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

function stimulusPrompt(payload) {
  if (
    typeof payload?.displayPrompt === "string" &&
    payload.displayPrompt.trim()
  ) {
    return payload.displayPrompt.trim();
  }
  const blocks = payload?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function parseJSONLines(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
