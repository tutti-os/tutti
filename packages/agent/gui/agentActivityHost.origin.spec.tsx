import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentActivityHostProvider,
  getAgentHostApiByOrigin,
  resetAgentHostApiForTests
} from "./agentActivityHost";
import {
  resetAgentActivityRuntimeForTests,
  type AgentActivityRuntime
} from "./agentActivityRuntime";
import type { AgentHostInputApi } from "./host/agentHostApi";

function createRuntime(origin: string): AgentActivityRuntime {
  return { origin } as unknown as AgentActivityRuntime;
}

function createHostApi(persistence: object): AgentHostInputApi {
  // Only `persistence` matters for read-state routing; the rest of the host
  // surface is irrelevant here.
  return { persistence } as unknown as AgentHostInputApi;
}

afterEach(() => {
  cleanup();
  resetAgentHostApiForTests();
  resetAgentActivityRuntimeForTests();
});

describe("getAgentHostApiByOrigin", () => {
  it("routes each origin's persistence to its own host API", () => {
    const localPersistence = { tag: "local" };
    const cloudPersistence = { tag: "cloud" };

    render(
      <>
        <AgentActivityHostProvider
          agentActivityRuntime={createRuntime("origin-local")}
          agentHostApi={createHostApi(localPersistence)}
        />
        <AgentActivityHostProvider
          agentActivityRuntime={createRuntime("origin-cloud")}
          agentHostApi={createHostApi(cloudPersistence)}
        />
      </>
    );

    expect(getAgentHostApiByOrigin("origin-local")?.persistence).toBe(
      localPersistence
    );
    expect(getAgentHostApiByOrigin("origin-cloud")?.persistence).toBe(
      cloudPersistence
    );
  });

  it("returns null for an unregistered explicit origin instead of cross-routing", () => {
    render(
      <AgentActivityHostProvider
        agentActivityRuntime={createRuntime("origin-local")}
        agentHostApi={createHostApi({ tag: "local" })}
      />
    );

    // Shared read-state must not be written to the local host's persistence.
    expect(getAgentHostApiByOrigin("origin-shared")).toBeNull();
  });
});
