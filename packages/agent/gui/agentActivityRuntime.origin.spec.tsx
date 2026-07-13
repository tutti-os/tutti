import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentActivityRuntimeProvider,
  resetAgentActivityRuntimeForTests,
  useAgentActivityRuntime,
  type AgentActivityRuntime
} from "./agentActivityRuntime";

function createRuntime(origin: string): AgentActivityRuntime {
  return { origin } as unknown as AgentActivityRuntime;
}

function RuntimeIdentity({ testId }: { testId: string }) {
  const runtime = useAgentActivityRuntime();
  return <div data-testid={testId}>{runtime.origin}</div>;
}

afterEach(() => {
  cleanup();
  resetAgentActivityRuntimeForTests();
});

describe("AgentActivityRuntimeProvider identity isolation", () => {
  it("resolves coexisting runtimes only from the nearest provider", () => {
    render(
      <>
        <AgentActivityRuntimeProvider runtime={createRuntime("origin-local")}>
          <RuntimeIdentity testId="local-runtime" />
        </AgentActivityRuntimeProvider>
        <AgentActivityRuntimeProvider runtime={createRuntime("origin-shared")}>
          <RuntimeIdentity testId="shared-runtime" />
        </AgentActivityRuntimeProvider>
      </>
    );

    expect(screen.getByTestId("local-runtime")).toHaveTextContent(
      "origin-local"
    );
    expect(screen.getByTestId("shared-runtime")).toHaveTextContent(
      "origin-shared"
    );
  });

  it("does not let a later sibling provider replace an existing consumer", () => {
    const view = render(
      <AgentActivityRuntimeProvider runtime={createRuntime("origin-local")}>
        <RuntimeIdentity testId="local-runtime" />
      </AgentActivityRuntimeProvider>
    );

    view.rerender(
      <>
        <AgentActivityRuntimeProvider runtime={createRuntime("origin-local")}>
          <RuntimeIdentity testId="local-runtime" />
        </AgentActivityRuntimeProvider>
        <AgentActivityRuntimeProvider runtime={createRuntime("origin-shared")}>
          <RuntimeIdentity testId="shared-runtime" />
        </AgentActivityRuntimeProvider>
      </>
    );

    expect(screen.getByTestId("local-runtime")).toHaveTextContent(
      "origin-local"
    );
  });
});
