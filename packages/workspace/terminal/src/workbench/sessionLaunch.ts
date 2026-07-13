import type {
  TerminalLaunchService,
  TerminalSessionDescriptor
} from "../contracts/index.ts";

export interface TerminalWorkbenchSessionLaunchIntent {
  cwd?: string | null;
  initialInput?: string | null;
  profileId?: string | null;
  sessionId?: string | null;
}

export async function resolveTerminalWorkbenchSessionLaunch(input: {
  intent: TerminalWorkbenchSessionLaunchIntent;
  launchService: TerminalLaunchService;
  reason: "dock" | "intent";
  workspaceId: string;
}): Promise<TerminalSessionDescriptor | null> {
  const requestedSessionId = input.intent.sessionId?.trim() || null;
  if (requestedSessionId) {
    return (await input.launchService.get?.(requestedSessionId)) ?? null;
  }
  return input.launchService.create({
    cwd: input.intent.cwd,
    initialInput: input.intent.initialInput,
    profileId: input.intent.profileId,
    reason: input.reason,
    workspaceId: input.workspaceId
  });
}
