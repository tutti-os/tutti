import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  forkSession,
  getSessionInfo,
  getSessionMessages
} from "@anthropic-ai/claude-agent-sdk";
import { readUserMessageNotificationText } from "./taskNotification.ts";

type SDKMessage = {
  type?: unknown;
  uuid?: unknown;
  session_id?: unknown;
  message?: unknown;
  parent_tool_use_id?: unknown;
  isSynthetic?: unknown;
  origin?: unknown;
};

type ForkInspectInput = {
  sessionId: string;
  cwd: string;
};

type ForkInput = ForkInspectInput & {
  providerTurnId: string;
  providerCheckpointMessageId: string;
  title: string;
};

type TurnBindingRecoveryInput = ForkInspectInput & {
  recoveryToken: string;
  legacyTextHMACKey: string;
  legacyTextHMACDigest: string;
};

export type ClaudeTurnBinding = {
  providerSessionId: string;
  providerTurnId: string;
  providerCheckpointMessageId: string;
};

export type ClaudeTurnBindingResolver = (input: {
  sessionId: string;
  cwd: string;
  recoveryToken: string;
}) => Promise<ClaudeTurnBinding>;

export type ClaudeTurnBindingResolutionDetails = {
  transcriptMessageCount: number;
  rootUserMessageCount: number;
  matchingRootUserMessageCount: number;
  latestRootUserMessageId: string;
};

export class ClaudeTurnBindingResolutionError extends Error {
  readonly reason: "absent" | "ambiguous";
  readonly details: ClaudeTurnBindingResolutionDetails | undefined;

  constructor(
    reason: "absent" | "ambiguous",
    details?: ClaudeTurnBindingResolutionDetails
  ) {
    super(`Claude provider turn recovery proof is ${reason}`);
    this.name = "ClaudeTurnBindingResolutionError";
    this.reason = reason;
    this.details = details;
  }
}

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

type ClaudeForkStage = "source_lookup" | "provider_fork" | "child_verification";

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

export async function recoverClaudeTurnBinding(
  input: TurnBindingRecoveryInput,
  sdk: ClaudeForkSDK = defaultClaudeForkSDK
): Promise<Record<string, unknown>> {
  return resolveClaudeTurnBinding(input, sdk);
}

export async function resolveClaudeTurnBindingByRecoveryToken(
  input: ForkInspectInput & { recoveryToken: string },
  sdk: ClaudeForkSDK = defaultClaudeForkSDK
): Promise<ClaudeTurnBinding> {
  requireIdentity(input.recoveryToken, "provider turn recovery token");
  return resolveClaudeTurnBinding(
    {
      ...input,
      legacyTextHMACKey: "",
      legacyTextHMACDigest: ""
    },
    sdk
  );
}

async function resolveClaudeTurnBinding(
  input: TurnBindingRecoveryInput,
  sdk: ClaudeForkSDK
): Promise<ClaudeTurnBinding> {
  requireIdentity(input.sessionId, "provider session id");
  const messages = (await sdk.getSessionMessages(
    input.sessionId,
    transcriptOptions(input.cwd)
  )) as SDKMessage[];
  const matches = rootTurnBindingMatches(messages, input);
  const rootMessages = messages.filter(isRootUserMessage);
  const details: ClaudeTurnBindingResolutionDetails = {
    transcriptMessageCount: messages.length,
    rootUserMessageCount: rootMessages.length,
    matchingRootUserMessageCount: matches.length,
    latestRootUserMessageId: messageIdentity(
      rootMessages[rootMessages.length - 1]
    )
  };
  if (matches.length === 0) {
    throw new ClaudeTurnBindingResolutionError("absent", details);
  }
  if (matches.length > 1) {
    throw new ClaudeTurnBindingResolutionError("ambiguous", details);
  }
  return {
    providerSessionId: input.sessionId,
    providerTurnId: matches[0]!.providerTurnId,
    providerCheckpointMessageId: matches[0]!.checkpointMessageId
  };
}

export async function forkClaudeSession(
  input: ForkInput,
  sdk: ClaudeForkSDK = defaultClaudeForkSDK
): Promise<Record<string, unknown>> {
  let forkStarted = false;
  let stage: ClaudeForkStage = "source_lookup";
  try {
    return await forkClaudeSessionResolved(input, sdk, (nextStage) => {
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

async function forkClaudeSessionResolved(
  input: ForkInput,
  sdk: ClaudeForkSDK,
  onStage: (stage: ClaudeForkStage) => void
): Promise<Record<string, unknown>> {
  requireIdentity(input.sessionId, "provider session id");
  requireIdentity(input.providerTurnId, "provider turn id");
  const options = sdkOptions(input.cwd);
  const transcriptReadOptions = transcriptOptions(input.cwd);
  let checkpointId = input.providerCheckpointMessageId.trim();
  if (!checkpointId) {
    const sourceMessages = (await sdk.getSessionMessages(
      input.sessionId,
      transcriptReadOptions
    )) as SDKMessage[];
    checkpointId = checkpointForProviderTurn(
      sourceMessages,
      input.providerTurnId
    );
  }
  requireIdentity(checkpointId, "checkpoint message id");

  onStage("provider_fork");
  let forkResult;
  try {
    forkResult = await forkProviderSession(sdk, input, options, checkpointId);
  } catch (error) {
    if (
      !input.providerCheckpointMessageId.trim() ||
      !isMissingPersistedCheckpoint(error, input.sessionId, checkpointId)
    ) {
      throw error;
    }
    // Older Tutti builds could persist UUIDs from Claude's ephemeral
    // session_state_changed notifications. The official SDK rejects that
    // checkpoint before creating a child, so this one recovery lookup is safe
    // and cannot duplicate a provider session.
    const sourceMessages = (await sdk.getSessionMessages(
      input.sessionId,
      transcriptReadOptions
    )) as SDKMessage[];
    const recoveredCheckpointId = checkpointForProviderTurn(
      sourceMessages,
      input.providerTurnId
    );
    if (recoveredCheckpointId === checkpointId) {
      throw error;
    }
    checkpointId = recoveredCheckpointId;
    forkResult = await forkProviderSession(sdk, input, options, checkpointId);
  }
  const childSessionId = messageIdentity(forkResult?.sessionId);
  requireUUID(childSessionId, "forked provider session id");
  if (childSessionId === input.sessionId) {
    throw new Error("forked provider session id equals source session id");
  }

  onStage("child_verification");
  const [childInfo, childMessages] = await Promise.all([
    sdk.getSessionInfo(childSessionId, options),
    sdk.getSessionMessages(childSessionId, transcriptReadOptions) as Promise<
      SDKMessage[]
    >
  ]);
  const childInfoSessionId = messageIdentity(childInfo?.sessionId);
  if (childInfoSessionId && childInfoSessionId !== childSessionId) {
    throw new Error("forked Claude session resolved to another session");
  }
  if (!childInfoSessionId && childMessages.length === 0) {
    throw new Error("forked Claude session is not independently discoverable");
  }
  const targetTurnBindings = providerTurnBindings(childMessages);
  if (targetTurnBindings.length === 0) {
    throw new Error("forked Claude session has no provider turn bindings");
  }
  const targetBoundaryBinding =
    targetTurnBindings[targetTurnBindings.length - 1]!;
  const receipt = createHash("sha256")
    .update(
      JSON.stringify({
        sourceSessionId: input.sessionId,
        childSessionId,
        checkpointId,
        targetTurnBindings,
        sourceProviderTurnId: input.providerTurnId,
        targetProviderTurnId: targetBoundaryBinding.providerTurnId
      })
    )
    .digest("hex");
  return {
    providerSessionId: childSessionId,
    targetProviderTurnBindings: targetTurnBindings,
    stateBindingMode: "provider_owned",
    stateBindingReceipt: `claude-sdk-fork-v3:${receipt}`,
    deliveryDisposition: "accepted"
  };
}

function forkProviderSession(
  sdk: ClaudeForkSDK,
  input: ForkInput,
  options: { dir?: string },
  checkpointId: string
) {
  return sdk.forkSession(input.sessionId, {
    ...options,
    upToMessageId: checkpointId,
    ...(input.title.trim() ? { title: input.title.trim() } : {})
  });
}

function isMissingPersistedCheckpoint(
  error: unknown,
  sessionId: string,
  checkpointId: string
): boolean {
  return (
    error instanceof Error &&
    error.message.trim() ===
      `Message ${checkpointId} not found in session ${sessionId}`
  );
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

function forkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "unknown error";
}

function checkpointForProviderTurn(
  messages: SDKMessage[],
  providerTurnId: string
): string {
  const selectedIndex = messages.findIndex(
    (message) =>
      isRootUserMessage(message) && messageIdentity(message) === providerTurnId
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
  const checkpointId = messageIdentity(messages[end - 1]);
  requireIdentity(checkpointId, "checkpoint message id");
  return checkpointId;
}

function providerTurnBindings(messages: SDKMessage[]): Array<{
  providerTurnId: string;
  checkpointMessageId: string;
}> {
  const result: Array<{
    providerTurnId: string;
    checkpointMessageId: string;
  }> = [];
  const seenProviderTurnIds = new Set<string>();
  const seenCheckpointMessageIds = new Set<string>();
  let current:
    | {
        providerTurnId: string;
        checkpointMessageId: string;
      }
    | undefined;
  const commitCurrent = () => {
    if (!current) {
      return;
    }
    const { providerTurnId, checkpointMessageId } = current;
    if (
      seenProviderTurnIds.has(providerTurnId) ||
      seenCheckpointMessageIds.has(checkpointMessageId)
    ) {
      throw new Error("forked Claude transcript contains duplicate bindings");
    }
    seenProviderTurnIds.add(providerTurnId);
    seenCheckpointMessageIds.add(checkpointMessageId);
    result.push({ providerTurnId, checkpointMessageId });
    current = undefined;
  };
  for (const message of messages) {
    if (isRootUserMessage(message)) {
      commitCurrent();
      const providerTurnId = messageIdentity(message);
      if (providerTurnId) {
        current = {
          providerTurnId,
          checkpointMessageId: providerTurnId
        };
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const checkpointMessageId = messageIdentity(message);
    if (checkpointMessageId) {
      current.checkpointMessageId = checkpointMessageId;
    }
  }
  commitCurrent();
  return result;
}

function rootTurnBindingMatches(
  messages: SDKMessage[],
  input: TurnBindingRecoveryInput
): Array<{ providerTurnId: string; checkpointMessageId: string }> {
  const bindings = providerTurnBindings(messages);
  const rootMessages = messages.filter(isRootUserMessage);
  if (bindings.length !== rootMessages.length) {
    throw new Error("Claude transcript contains incomplete root turn bindings");
  }
  const recoveryToken = input.recoveryToken.trim();
  const legacyKey = decodeBase64URL(input.legacyTextHMACKey);
  const legacyDigest = decodeBase64URL(input.legacyTextHMACDigest);
  const result: Array<{
    providerTurnId: string;
    checkpointMessageId: string;
  }> = [];
  for (let index = 0; index < rootMessages.length; index += 1) {
    const root = rootMessages[index]!;
    const providerTurnId = messageIdentity(root);
    const text = exactPureText(root);
    const tokenMatch = recoveryToken !== "" && providerTurnId === recoveryToken;
    const legacyMatch =
      !recoveryToken &&
      text !== undefined &&
      legacyKey.length > 0 &&
      legacyDigest.length > 0 &&
      safeEqual(
        createHmac("sha256", legacyKey).update(text).digest(),
        legacyDigest
      );
    if (tokenMatch || legacyMatch) {
      result.push(bindings[index]!);
    }
  }
  return result;
}

function exactPureText(message: SDKMessage): string | undefined {
  const content =
    message.message && typeof message.message === "object"
      ? (message.message as { content?: unknown }).content
      : undefined;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      Array.isArray(block) ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    ) {
      return undefined;
    }
    texts.push((block as { text: string }).text);
  }
  return texts.join("\n\n");
}

function decodeBase64URL(value: string): Buffer {
  const normalized = value.trim();
  if (!normalized) {
    return Buffer.alloc(0);
  }
  try {
    return Buffer.from(normalized, "base64url");
  } catch {
    return Buffer.alloc(0);
  }
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
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
  if (
    message?.type !== "user" ||
    message?.parent_tool_use_id ||
    message?.isSynthetic === true ||
    hasToolResultBlock(message)
  ) {
    return false;
  }
  const origin =
    message.origin && typeof message.origin === "object"
      ? (message.origin as { kind?: unknown })
      : undefined;
  if (origin?.kind === "coordinator") {
    return false;
  }
  return !readUserMessageNotificationText(
    message as { message?: { content?: unknown } }
  ).includes("<task-notification>");
}

function hasToolResultBlock(message: SDKMessage): boolean {
  const providerMessage =
    message.message && typeof message.message === "object"
      ? (message.message as { content?: unknown })
      : undefined;
  return (
    Array.isArray(providerMessage?.content) &&
    providerMessage.content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "tool_result"
    )
  );
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
