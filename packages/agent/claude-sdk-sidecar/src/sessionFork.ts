import { createHash } from "node:crypto";
import {
  forkSession,
  getSessionInfo,
  getSessionMessages
} from "@anthropic-ai/claude-agent-sdk";

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
  title: string;
};

type ClaudeForkSDK = {
  forkSession: typeof forkSession;
  getSessionMessages: typeof getSessionMessages;
  getSessionInfo: typeof getSessionInfo;
};

const defaultClaudeForkSDK: ClaudeForkSDK = {
  forkSession,
  getSessionMessages,
  getSessionInfo
};

type ClaudeForkStage =
  | "source_validation"
  | "provider_fork"
  | "child_verification";

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
  let stage: ClaudeForkStage = "source_validation";
  try {
    return await forkClaudeSessionVerified(input, sdk, (nextStage) => {
      stage = nextStage;
      if (nextStage === "provider_fork") {
        forkStarted = true;
      }
    });
  } catch (error) {
    throw new ClaudeForkError(
      forkStarted ? "unknown" : "not_started",
      stage,
      error
    );
  }
}

async function forkClaudeSessionVerified(
  input: ForkInput,
  sdk: ClaudeForkSDK,
  onStage: (stage: ClaudeForkStage) => void
): Promise<Record<string, unknown>> {
  requireIdentity(input.sessionId, "provider session id");
  requireIdentity(input.providerTurnId, "provider turn id");
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

  onStage("provider_fork");
  const forkResult = await sdk.forkSession(input.sessionId, {
    ...options,
    upToMessageId: checkpointId,
    ...(input.title.trim() ? { title: input.title.trim() } : {})
  });
  const childSessionId = messageIdentity(forkResult?.sessionId);
  requireUUID(childSessionId, "forked provider session id");
  if (childSessionId === input.sessionId) {
    throw new Error("forked provider session id equals source session id");
  }

  onStage("child_verification");
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
  const childInfoSessionId = messageIdentity(childInfo?.sessionId);
  if (childInfoSessionId && childInfoSessionId !== childSessionId) {
    throw new Error("forked Claude session resolved to another session");
  }
  if (!childInfoSessionId && childMessages.length === 0) {
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
  const observableSourcePrefix = forkObservablePrefix(sourcePrefix);
  assertStructuralEquality(
    observableSourcePrefix,
    childMessages,
    "forked Claude transcript does not equal the selected source prefix"
  );

  const targetProviderTurnIds = rootProviderTurnIds(childMessages);
  if (targetProviderTurnIds.length !== expectedTurnIds.length) {
    throw new Error("forked Claude transcript has a different root Turn count");
  }
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
  readonly stage: ClaudeForkStage;

  constructor(
    deliveryDisposition: "not_started" | "unknown",
    stage: ClaudeForkStage,
    cause: unknown
  ) {
    super(
      `Claude SDK session fork failed at ${stage}: ${forkErrorMessage(cause)}`
    );
    this.deliveryDisposition = deliveryDisposition;
    this.stage = stage;
  }
}

function forkObservablePrefix(messages: SDKMessage[]): SDKMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.type === "system") {
    end -= 1;
  }
  return messages.slice(0, end);
}

function forkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "unknown error";
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
