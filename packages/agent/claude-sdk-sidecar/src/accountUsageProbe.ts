import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutablePath } from "./executablePath.ts";
import { AsyncPromptQueue } from "./promptQueue.ts";
import { booleanValue, stringValue } from "./runtimeValues.ts";

type AccountUsageQuery = AsyncIterable<SDKMessage> & {
  initializationResult(): Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<unknown>;
  close(): void;
};

type AccountUsageQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeQueryOptions;
}) => AccountUsageQuery;

export type ClaudeAccountUsageSnapshot = {
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  rateLimits: Record<string, unknown> | null;
};

export async function probeClaudeAccountUsage(
  input: {
    cwd: string;
    env: Record<string, string | undefined>;
  },
  queryFactory: AccountUsageQueryFactory = query
): Promise<ClaudeAccountUsageSnapshot> {
  const promptQueue = new AsyncPromptQueue();
  const env = { ...process.env, ...input.env };
  const executable = resolveClaudeCodeExecutablePath(env);
  const accountQuery = queryFactory({
    prompt: promptQueue.iterate(),
    options: {
      cwd: input.cwd || process.cwd(),
      env,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {})
    }
  });
  try {
    await accountQuery.initializationResult();
    const usage =
      await accountQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    return normalizeClaudeAccountUsage(usage);
  } finally {
    accountQuery.close();
    promptQueue.close();
  }
}

export function normalizeClaudeAccountUsage(
  value: unknown
): ClaudeAccountUsageSnapshot {
  const usage = recordValue(value);
  if (!usage) {
    throw new Error("Claude SDK get_usage returned an invalid response");
  }
  const rateLimitsAvailable = booleanValue(usage.rate_limits_available);
  if (typeof usage.rate_limits_available !== "boolean") {
    throw new Error("Claude SDK get_usage omitted rate_limits_available");
  }
  const rawRateLimits = usage.rate_limits;
  const rateLimits = rawRateLimits === null ? null : recordValue(rawRateLimits);
  if (rawRateLimits !== null && !rateLimits) {
    throw new Error("Claude SDK get_usage returned invalid rate_limits");
  }
  return {
    subscriptionType: stringValue(usage.subscription_type) || null,
    rateLimitsAvailable,
    rateLimits: rateLimits ? sanitizeRateLimits(rateLimits) : null
  };
}

function sanitizeRateLimits(value: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const key of [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_opus",
    "seven_day_sonnet",
    "model_scoped",
    "extra_usage"
  ]) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
