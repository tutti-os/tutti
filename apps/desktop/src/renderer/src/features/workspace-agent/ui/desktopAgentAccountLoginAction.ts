import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";

export function isDesktopAgentAccountLoginAction(
  status: AgentProviderStatus | null | undefined
): boolean {
  return (
    status?.actions.some(
      (action) => action.id === "login" && action.kind === "daemon_action"
    ) === true
  );
}
