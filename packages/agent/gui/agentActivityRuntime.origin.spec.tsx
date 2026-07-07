import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentActivityRuntimeProvider,
  getAgentActivityRuntimeByOrigin,
  resetAgentActivityRuntimeForTests,
  type AgentActivityRuntime
} from "./agentActivityRuntime";
import { WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN } from "./shared/workspaceAgentActivityTypes";

function createRuntime(origin?: string): AgentActivityRuntime {
  // Only `origin` participates in registry resolution; the rest of the surface
  // is irrelevant for this test, so a tagged stub is sufficient.
  return { origin } as unknown as AgentActivityRuntime;
}

afterEach(() => {
  cleanup();
  resetAgentActivityRuntimeForTests();
});

describe("getAgentActivityRuntimeByOrigin", () => {
  it("resolves two coexisting runtimes independently by origin", () => {
    const localRuntime = createRuntime("origin-local");
    const sharedRuntime = createRuntime("origin-shared");

    render(
      <>
        <AgentActivityRuntimeProvider runtime={localRuntime} />
        <AgentActivityRuntimeProvider runtime={sharedRuntime} />
      </>
    );

    expect(getAgentActivityRuntimeByOrigin("origin-local")).toBe(localRuntime);
    expect(getAgentActivityRuntimeByOrigin("origin-shared")).toBe(
      sharedRuntime
    );
  });

  it("registers an origin-less runtime under the default origin", () => {
    const localRuntime = createRuntime();

    render(<AgentActivityRuntimeProvider runtime={localRuntime} />);

    expect(
      getAgentActivityRuntimeByOrigin(
        WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN
      )
    ).toBe(localRuntime);
  });

  it("removes an origin from the registry after its provider unmounts", () => {
    const sharedRuntime = createRuntime("origin-shared");
    const localRuntime = createRuntime("origin-local");

    // Render shared first, local last, so the module-global fallback settles on
    // localRuntime — letting us prove origin-shared is gone from the registry by
    // observing it fall back rather than resolve to sharedRuntime.
    const view = render(
      <>
        <AgentActivityRuntimeProvider runtime={sharedRuntime} />
        <AgentActivityRuntimeProvider runtime={localRuntime} />
      </>
    );
    expect(getAgentActivityRuntimeByOrigin("origin-shared")).toBe(
      sharedRuntime
    );

    view.rerender(<AgentActivityRuntimeProvider runtime={localRuntime} />);

    expect(getAgentActivityRuntimeByOrigin("origin-shared")).toBe(localRuntime);
    expect(getAgentActivityRuntimeByOrigin("origin-local")).toBe(localRuntime);
  });
});
