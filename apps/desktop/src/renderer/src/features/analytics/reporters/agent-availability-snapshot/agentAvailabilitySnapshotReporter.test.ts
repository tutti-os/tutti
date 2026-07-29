import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../../services/reporterService.interface.ts";
import { AgentAvailabilitySnapshotReporter } from "./agentAvailabilitySnapshotReporter.ts";

test("availability snapshot reporter emits the spec event", async () => {
  const events: ReporterEventInput[] = [];
  await new AgentAvailabilitySnapshotReporter(
    {
      authenticated: true,
      cliInstalled: true,
      isAvailable: true,
      provider: "claude_code",
      trigger: "env_detected",
      unavailableReason: "none"
    },
    {
      now: () => 1_749_124_800_000,
      reporterService: {
        async trackEvents(input) {
          events.push(...input);
        }
      }
    }
  ).report();

  assert.deepEqual(events, [
    {
      clientTS: 1_749_124_800_000,
      name: "agent.availability_snapshot",
      params: {
        authenticated: true,
        cli_installed: true,
        error_code: "agent_error_none",
        error_message: "",
        is_available: true,
        provider: "claude_code",
        trigger: "env_detected",
        unavailable_reason: "none"
      }
    }
  ]);
});
