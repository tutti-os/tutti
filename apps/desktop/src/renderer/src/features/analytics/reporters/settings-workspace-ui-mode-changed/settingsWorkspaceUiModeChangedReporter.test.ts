import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../../services/reporterService.interface.ts";
import { SettingsWorkspaceUiModeChangedReporter } from "./settingsWorkspaceUiModeChangedReporter.ts";

test("workspace UI mode changed reporter emits the typed event with protocol params", async () => {
  const calls: ReporterEventInput[][] = [];
  const reporter = new SettingsWorkspaceUiModeChangedReporter(
    {
      action: "enabled",
      previousMode: "os",
      nextMode: "agent"
    },
    {
      reporterService: {
        async trackEvents(events) {
          calls.push(events);
        }
      },
      now: () => 1749124800000
    }
  );

  await reporter.report();

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "settings.workspace_ui_mode_changed",
        params: {
          action: "enabled",
          previous_mode: "os",
          next_mode: "agent"
        }
      }
    ]
  ]);
});
