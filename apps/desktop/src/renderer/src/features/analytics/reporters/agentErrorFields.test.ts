import assert from "node:assert/strict";
import test from "node:test";
import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "./baseReporter.ts";
import {
  AgentAnalyticsErrorCode,
  agentAnalyticsSuccessFields
} from "./agent-error-fields.ts";
import type { ReporterEventInput } from "../services/reporterService.interface.ts";

class AgentTestReporter extends BaseAnalyticsReporter<{
  provider: string;
}> {
  protected readonly eventName = "agent.test_event";

  constructor(
    params: { provider: string },
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}

class ErrorTestReporter extends BaseAnalyticsReporter<{
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
  provider: string;
}> {
  protected readonly eventName = "error.agent_session_failed";

  constructor(
    params: {
      errorCode: AgentAnalyticsErrorCode;
      errorMessage: string;
      provider: string;
    },
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}

function deps(events: ReporterEventInput[]): AnalyticsReporterDependencies {
  return {
    now: () => 1749124800000,
    reporterService: {
      async trackEvents(input) {
        events.push(...input);
      }
    }
  };
}

test("agent reporters default success error fields when omitted", async () => {
  const events: ReporterEventInput[] = [];

  await new AgentTestReporter({ provider: "codex" }, deps(events)).report();

  assert.deepEqual(events, [
    {
      clientTS: 1749124800000,
      name: "agent.test_event",
      params: {
        error_code: "agent_error_none",
        error_message: "",
        provider: "codex"
      }
    }
  ]);
});

test("agent error reporters preserve explicit error fields", async () => {
  const events: ReporterEventInput[] = [];

  await new ErrorTestReporter(
    {
      errorCode: AgentAnalyticsErrorCode.RuntimeExecFailed,
      errorMessage: "network disconnected",
      provider: "codex"
    },
    deps(events)
  ).report();

  assert.deepEqual(events, [
    {
      clientTS: 1749124800000,
      name: "error.agent_session_failed",
      params: {
        error_code: "agent_runtime_exec_failed",
        error_message: "network disconnected",
        provider: "codex"
      }
    }
  ]);
});

test("agentAnalyticsSuccessFields uses the no-error enum", () => {
  assert.deepEqual(agentAnalyticsSuccessFields, {
    errorCode: AgentAnalyticsErrorCode.None,
    errorMessage: ""
  });
});
