import { createHash } from "node:crypto";
import {
  getSessionInfo,
  getSessionMessages,
  query,
  type Options,
  type Query
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutablePath } from "./executablePath.ts";
import { AsyncPromptQueue } from "./promptQueue.ts";
import { claudeSettingsEnv } from "./settingsEnv.ts";

type SDKMessage = {
  type?: unknown;
  uuid?: unknown;
  session_id?: unknown;
  message?: unknown;
  parent_tool_use_id?: unknown;
};

type ForkInspectInput = {
  sessionId: string;
  cwd: string;
};

type ForkInput = ForkInspectInput & {
  providerTurnId: string;
  providerTurnIds: string[];
  targetSessionId: string;
  title: string;
};

type ClaudeForkSDK = {
  getSessionMessages: typeof getSessionMessages;
  getSessionInfo: typeof getSessionInfo;
  query: typeof query;
};

const defaultClaudeForkSDK: ClaudeForkSDK = {
  getSessionMessages,
  getSessionInfo,
  query
};

export async function inspectClaudeForkCheckpoints(
  input: ForkInspectInput,
  sdk: ClaudeForkSDK = defaultClaudeForkSDK
): Promise<Record<string, unknown>> {
  requireIdentity(input.sessionId, "provider session id");
  const messages = (await sdk.getSessionMessages(
    input.sessionId,
    transcriptOptions(input.cwd)
  )) as SDKMessage[];
  return {
    providerTurnIds: rootProviderTurnIds(messages)
  };
}

export async function forkClaudeSession(
  input: ForkInput,
  sdk: ClaudeForkSDK = defaultClaudeForkSDK
): Promise<Record<string, unknown>> {
  let forkStarted = false;
  try {
    return await forkClaudeSessionVerified(input, sdk, () => {
      forkStarted = true;
    });
  } catch {
    throw new ClaudeForkError(forkStarted ? "unknown" : "not_started");
  }
}

async function forkClaudeSessionVerified(
  input: ForkInput,
  sdk: ClaudeForkSDK,
  onForkStarted: () => void
): Promise<Record<string, unknown>> {
  requireIdentity(input.sessionId, "provider session id");
  requireIdentity(input.providerTurnId, "provider turn id");
  requireUUID(input.targetSessionId, "target provider session id");
  if (input.targetSessionId === input.sessionId) {
    throw new Error("target provider session id equals source session id");
  }
  const expectedTurnIds = normalizedIdentities(input.providerTurnIds);
  if (
    expectedTurnIds.length === 0 ||
    expectedTurnIds.at(-1) !== input.providerTurnId
  ) {
    throw new Error("provider turn prefix does not end at the selected turn");
  }

  const options = sdkOptions(input.cwd);
  const transcriptReadOptions = transcriptOptions(input.cwd);
  const sourceA = (await sdk.getSessionMessages(
    input.sessionId,
    transcriptReadOptions
  )) as SDKMessage[];
  const sourcePrefix = exactSourcePrefix(sourceA, expectedTurnIds);
  const sourceMessageIds = messageIdentities(
    sourcePrefix,
    "source transcript prefix"
  );
  const checkpointId = sourceMessageIds.at(-1) ?? "";
  requireIdentity(checkpointId, "checkpoint message id");

  const existingChild = await readExistingChild(
    input.targetSessionId,
    options,
    transcriptReadOptions,
    sdk
  );
  if (existingChild.exists) {
    onForkStarted();
    return verifiedForkResult({
      input,
      checkpointId,
      sourcePrefix,
      sourceMessageIds,
      childSessionId: input.targetSessionId,
      childMessages: existingChild.messages,
      expectedTurnIds
    });
  }

  onForkStarted();
  await initializeDeterministicFork(input, checkpointId, sdk);
  const childSessionId = input.targetSessionId;

  const [sourceB, childInfo, childMessages] = await Promise.all([
    sdk.getSessionMessages(input.sessionId, transcriptReadOptions) as Promise<
      SDKMessage[]
    >,
    sdk.getSessionInfo(childSessionId, options),
    sdk.getSessionMessages(childSessionId, transcriptReadOptions) as Promise<
      SDKMessage[]
    >
  ]);
  const sourcePrefixB = exactSourcePrefix(sourceB, expectedTurnIds);
  const sourceMessageIdsB = messageIdentities(
    sourcePrefixB,
    "re-read source transcript prefix"
  );
  assertStructuralEquality(
    sourcePrefix,
    sourcePrefixB,
    "source transcript changed during fork"
  );
  assertIdentityEquality(
    sourceMessageIds,
    sourceMessageIdsB,
    "source transcript identities changed during fork"
  );
  if (messageIdentity(childInfo?.sessionId) !== childSessionId) {
    throw new Error("forked Claude session is not independently discoverable");
  }
  return verifiedForkResult({
    input,
    checkpointId,
    sourcePrefix,
    sourceMessageIds,
    childSessionId,
    childMessages,
    expectedTurnIds
  });
}

async function readExistingChild(
  childSessionId: string,
  infoOptions: { dir?: string },
  transcriptReadOptions: { dir?: string; includeSystemMessages: true },
  sdk: ClaudeForkSDK
): Promise<{ exists: boolean; messages: SDKMessage[] }> {
  const [info, messages] = await Promise.all([
    sdk.getSessionInfo(childSessionId, infoOptions),
    sdk.getSessionMessages(childSessionId, transcriptReadOptions) as Promise<
      SDKMessage[]
    >
  ]);
  const infoSessionId = messageIdentity(info?.sessionId);
  if (infoSessionId && infoSessionId !== childSessionId) {
    throw new Error("deterministic Claude child resolved to another session");
  }
  return {
    exists: infoSessionId === childSessionId || messages.length !== 0,
    messages
  };
}

// LIMITATION / SDK upgrade checkpoint:
//
// The pinned official SDK's direct forkSession() API chooses a random child
// UUID and has no idempotency key, so it cannot implement Host's deterministic
// replay contract. query() is used only to initialize
// resume + forkSession + sessionId + resumeSessionAt with an empty prompt.
//
// A provider interruption can still leave the requested UUID present but with
// a partial or unverifiable transcript. We deliberately return delivery
// "unknown" in that case: deleting provider-owned state or creating a second
// UUID would violate exactly-once safety.
//
// When upgrading @anthropic-ai/claude-agent-sdk, re-check whether
// forkSession() supports a caller-supplied child UUID/idempotency key and an
// atomic or reliably reconcilable durable result. If it does, replace this
// query() workaround and revisit the fail-closed partial-child path above.
async function initializeDeterministicFork(
  input: ForkInput,
  checkpointId: string,
  sdk: ClaudeForkSDK
): Promise<void> {
  const promptQueue = new AsyncPromptQueue();
  const cwd = input.cwd.trim() || process.cwd();
  const settingsEnv = claudeSettingsEnv(cwd);
  const env = {
    ...process.env,
    ...settingsEnv
  };
  const executablePath = resolveClaudeCodeExecutablePath(env);
  const title = input.title.trim();
  const options: Options = {
    cwd,
    env,
    resume: input.sessionId,
    forkSession: true,
    sessionId: input.targetSessionId,
    resumeSessionAt: checkpointId,
    ...(title ? { title } : {}),
    ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {})
  };
  const forkQuery = sdk.query({
    // Initialization performs the provider fork. Deliberately never enqueue a
    // user message: the child must end exactly at the selected checkpoint.
    prompt: promptQueue.iterate(),
    options
  }) as Query;
  try {
    await forkQuery.initializationResult();
  } finally {
    promptQueue.close();
    forkQuery.close();
  }
}

function verifiedForkResult(input: {
  input: ForkInput;
  checkpointId: string;
  sourcePrefix: SDKMessage[];
  sourceMessageIds: string[];
  childSessionId: string;
  childMessages: SDKMessage[];
  expectedTurnIds: string[];
}): Record<string, unknown> {
  const {
    checkpointId,
    sourcePrefix,
    sourceMessageIds,
    childSessionId,
    childMessages,
    expectedTurnIds
  } = input;
  const childMessageIds = messageIdentities(
    childMessages,
    "forked transcript prefix"
  );
  assertStructuralEquality(
    sourcePrefix,
    childMessages,
    "forked Claude transcript does not equal the selected source prefix"
  );

  const sourceIndexById = new Map(
    sourcePrefix.map((message, index) => [messageIdentity(message), index])
  );
  const targetProviderTurnIds = expectedTurnIds.map((sourceId) => {
    const index = sourceIndexById.get(sourceId);
    if (index === undefined) {
      throw new Error("source provider turn is absent from verified prefix");
    }
    return childMessageIds[index];
  });
  const targetCheckpointId = childMessageIds.at(-1) ?? "";
  const receipt = createHash("sha256")
    .update(
      JSON.stringify({
        sourceSessionId: input.input.sessionId,
        childSessionId,
        checkpointId,
        targetCheckpointId,
        sourceMessageIds,
        expectedTurnIds,
        targetProviderTurnIds
      })
    )
    .digest("hex");
  return {
    providerSessionId: childSessionId,
    targetProviderTurnIds,
    stateBindingMode: "provider_owned",
    stateBindingReceipt: `claude-sdk-fork-v1:${receipt}`,
    deliveryDisposition: "accepted"
  };
}

class ClaudeForkError extends Error {
  readonly deliveryDisposition: "not_started" | "unknown";

  constructor(deliveryDisposition: "not_started" | "unknown") {
    super("Claude SDK session fork failed");
    this.deliveryDisposition = deliveryDisposition;
  }
}

function exactSourcePrefix(
  messages: SDKMessage[],
  expectedTurnIds: string[]
): SDKMessage[] {
  const actualRootIds = rootProviderTurnIds(messages);
  if (
    expectedTurnIds.some((turnId, index) => actualRootIds[index] !== turnId)
  ) {
    throw new Error(
      "canonical provider turn prefix does not match Claude transcript"
    );
  }
  const selectedIndex = messages.findIndex(
    (message) =>
      isRootUserMessage(message) &&
      messageIdentity(message) === expectedTurnIds.at(-1)
  );
  if (selectedIndex < 0) {
    throw new Error("selected provider turn is absent from Claude transcript");
  }
  const nextRootIndex = messages.findIndex(
    (message, index) => index > selectedIndex && isRootUserMessage(message)
  );
  const end = nextRootIndex < 0 ? messages.length : nextRootIndex;
  if (end <= selectedIndex) {
    throw new Error(
      "selected provider turn has no exact transcript checkpoint"
    );
  }
  return messages.slice(0, end);
}

function rootProviderTurnIds(messages: SDKMessage[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!isRootUserMessage(message)) {
      continue;
    }
    const identity = messageIdentity(message);
    if (!identity || seen.has(identity)) {
      throw new Error(
        "Claude transcript contains an invalid root user identity"
      );
    }
    seen.add(identity);
    result.push(identity);
  }
  return result;
}

function isRootUserMessage(message: SDKMessage): boolean {
  return message?.type === "user" && !message?.parent_tool_use_id;
}

function assertStructuralEquality(
  source: SDKMessage[],
  target: SDKMessage[],
  error: string
): void {
  if (
    source.length !== target.length ||
    source.some(
      (message, index) =>
        JSON.stringify(normalizedMessage(message)) !==
        JSON.stringify(normalizedMessage(target[index]))
    )
  ) {
    throw new Error(error);
  }
}

function normalizedMessage(
  message: SDKMessage | undefined
): Record<string, unknown> {
  return {
    type: message?.type,
    message: message?.message,
    parent_tool_use_id: message?.parent_tool_use_id ?? null
  };
}

function messageIdentities(messages: SDKMessage[], label: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const identity = messageIdentity(message);
    if (!identity || seen.has(identity)) {
      throw new Error(`${label} does not have a complete identity bijection`);
    }
    seen.add(identity);
    result.push(identity);
  }
  return result;
}

function assertIdentityEquality(
  source: string[],
  target: string[],
  error: string
): void {
  if (
    source.length !== target.length ||
    source.some((identity, index) => identity !== target[index])
  ) {
    throw new Error(error);
  }
}

function sdkOptions(cwd: string): { dir?: string } {
  const dir = cwd.trim();
  return dir ? { dir } : {};
}

function transcriptOptions(cwd: string): {
  dir?: string;
  includeSystemMessages: true;
} {
  return {
    ...sdkOptions(cwd),
    includeSystemMessages: true
  };
}

function normalizedIdentities(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const identity = value.trim();
    if (!identity || seen.has(identity)) {
      throw new Error("provider turn prefix contains an invalid identity");
    }
    seen.add(identity);
    result.push(identity);
  }
  return result;
}

function messageIdentity(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object" && "uuid" in value) {
    return messageIdentity((value as { uuid?: unknown }).uuid);
  }
  return "";
}

function requireIdentity(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required`);
  }
}

function requireUUID(value: string, label: string): void {
  requireIdentity(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim()
    )
  ) {
    throw new Error(`${label} must be a UUID`);
  }
}
