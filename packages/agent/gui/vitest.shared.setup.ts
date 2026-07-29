import { afterEach, beforeEach } from "vitest";
import {
  resetAgentHostApiForTests,
  setAgentHostApiForTests
} from "./agentActivityHost";
import type { AgentHostRuntimeApi } from "./host/agentHostApi";
import { installReactRenderLoopConsoleTrap } from "./test/reactRenderLoopConsoleTrap";

// Vitest 4 runs with NODE_ENV=development; agent test harnesses gate on "test".
process.env.NODE_ENV = "test";

const originalConsoleInfo = console.info.bind(console);
console.info = (...args: unknown[]) => {
  if (isSuppressedAgentGuiDiagnostic(args)) {
    return;
  }
  originalConsoleInfo(...args);
};

let restoreReactRenderLoopConsoleTrap: (() => void) | null = null;

beforeEach(() => {
  restoreReactRenderLoopConsoleTrap?.();
  restoreReactRenderLoopConsoleTrap = installReactRenderLoopConsoleTrap({
    console
  });
  resetAgentHostApiForTests();
  resetMentionSearchBrowseCacheForTests();
  setAgentHostApiForTests(createTestAgentHostApi());
});

afterEach(() => {
  try {
    resetAgentHostApiForTests();
    resetMentionSearchBrowseCacheForTests();
  } finally {
    restoreReactRenderLoopConsoleTrap?.();
    restoreReactRenderLoopConsoleTrap = null;
  }
});

export function createTestAgentHostApi(): AgentHostRuntimeApi {
  return {
    account: {},
    clipboard: {},
    debug: {},
    filesystem: {},
    workspace: {}
  } as unknown as AgentHostRuntimeApi;
}

function resetMentionSearchBrowseCacheForTests(): void {
  (
    globalThis as typeof globalThis & {
      __tuttiResetAgentMentionSearchBrowseCacheForTests?: () => void;
    }
  ).__tuttiResetAgentMentionSearchBrowseCacheForTests?.();
}

function isSuppressedAgentGuiDiagnostic(args: readonly unknown[]): boolean {
  const [prefix] = args;
  return (
    prefix === "[agent-gui] mention-lifecycle" ||
    prefix === "[agent-gui] mention-search"
  );
}
