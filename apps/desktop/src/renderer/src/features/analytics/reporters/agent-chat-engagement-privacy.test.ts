import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../services/reporterService.interface.ts";
import { AgentChatInputContentEnteredReporter } from "./agent-chat-input-content-entered/agentChatInputContentEnteredReporter.ts";
import type { AgentChatInputContentEnteredParams } from "./agent-chat-input-content-entered/types.ts";
import { AgentChatInputFocusedReporter } from "./agent-chat-input-focused/agentChatInputFocusedReporter.ts";
import type { AgentChatInputFocusedParams } from "./agent-chat-input-focused/types.ts";
import { AgentChatPanelExposedReporter } from "./agent-chat-panel-exposed/agentChatPanelExposedReporter.ts";
import type { AgentChatPanelExposedParams } from "./agent-chat-panel-exposed/types.ts";

test("Agent chat engagement reporters discard undeclared privacy-sensitive fields", async () => {
  const calls: ReporterEventInput[][] = [];
  const dependencies = {
    now: () => 1_749_124_800_000,
    reporterService: {
      trackEvents: async (events: ReporterEventInput[]) => {
        calls.push(events);
      }
    }
  };
  const base = {
    agentSessionId: "session-1",
    agentTargetId: "codex-local",
    composerReady: true,
    conversationState: "existing" as const,
    panelVisitId: "visit-1",
    prompt: "do not transmit",
    provider: "codex",
    surface: "workspace" as const
  };

  await new AgentChatPanelExposedReporter(
    base as AgentChatPanelExposedParams & { prompt: string },
    dependencies
  ).report();
  await new AgentChatInputFocusedReporter(
    {
      ...base,
      focusMethod: "keyboard"
    } as AgentChatInputFocusedParams & { prompt: string },
    dependencies
  ).report();
  await new AgentChatInputContentEnteredReporter(
    {
      ...base,
      contentType: "text",
      hadPrefill: false
    } as AgentChatInputContentEnteredParams & { prompt: string },
    dependencies
  ).report();

  assert.equal(JSON.stringify(calls).includes("do not transmit"), false);
  assert.equal(JSON.stringify(calls).includes("prompt"), false);
});
