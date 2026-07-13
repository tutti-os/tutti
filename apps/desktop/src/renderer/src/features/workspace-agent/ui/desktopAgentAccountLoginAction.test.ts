import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import { isDesktopAgentAccountLoginAction } from "./desktopAgentAccountLoginAction.ts";

test("account login routing follows the daemon action kind instead of provider identity", () => {
  assert.equal(
    isDesktopAgentAccountLoginAction(
      status("custom-provider", "daemon_action")
    ),
    true
  );
  assert.equal(
    isDesktopAgentAccountLoginAction(status("tutti-agent", "terminal_command")),
    false
  );
});

function status(
  provider: string,
  kind: "daemon_action" | "terminal_command"
): AgentProviderStatus {
  return {
    provider: provider as AgentProviderStatus["provider"],
    availability: { status: "auth_required" },
    cli: { installed: true },
    adapter: { installed: true, command: [] },
    auth: { status: "required" },
    actions: [{ id: "login", kind }]
  };
}
