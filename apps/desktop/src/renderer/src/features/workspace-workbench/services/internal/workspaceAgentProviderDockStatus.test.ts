import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import { resolveAgentProviderDockStatusProps } from "./workspaceAgentProviderDockStatus.ts";

const copy = {
  checking: "checking",
  install: "Connect",
  installing: "Connecting...",
  installRequired: "Connect local agent to continue",
  login: "login",
  loginRequired: "login required",
  refresh: "refresh",
  unsupported: "coming soon",
  unknown: "unknown"
};

test("agent provider dock status shows loading only while status is loading", () => {
  const props = resolveAgentProviderDockStatusProps({
    copy,
    isLoading: true,
    status: null
  });

  assert.deepEqual(props, {
    state: {
      kind: "loading",
      reason: "checking"
    }
  });
});

test("agent provider dock status falls back to unavailable when status is missing after load", () => {
  const props = resolveAgentProviderDockStatusProps({
    copy,
    isLoading: false,
    status: null
  });

  assert.deepEqual(props, {
    hoverActions: [{ id: "refresh", label: "refresh" }],
    state: {
      kind: "unavailable",
      reason: "unknown"
    }
  });
});

test("agent provider dock status shows connect and refresh for not installed providers", () => {
  const props = resolveAgentProviderDockStatusProps({
    copy,
    isLoading: false,
    status: createStatus({
      actions: [
        { id: "install", kind: "daemon_action" },
        { id: "refresh", kind: "refresh" }
      ],
      availability: "not_installed"
    })
  });

  assert.deepEqual(props.hoverActions, [
    { id: "install", label: "Connect" },
    { id: "refresh", label: "refresh" }
  ]);
  assert.ok(props.state);
  assert.equal(props.state.reason, "Connect local agent to continue");
});

test("agent provider dock status shows loading while install is pending", () => {
  const props = resolveAgentProviderDockStatusProps({
    copy,
    isLoading: false,
    pendingActionIds: new Set(["install"]),
    status: createStatus({
      actions: [
        { id: "install", kind: "daemon_action" },
        { id: "refresh", kind: "refresh" }
      ],
      availability: "not_installed"
    })
  });

  assert.deepEqual(props, {
    hoverActions: [
      {
        disabled: true,
        id: "install",
        label: "Connect",
        pendingLabel: "Connecting..."
      },
      { id: "refresh", label: "refresh" }
    ],
    state: {
      kind: "loading",
      reason: "Connecting..."
    }
  });
});

test("agent provider dock status shows login reason with login and refresh actions for auth required providers", () => {
  const props = resolveAgentProviderDockStatusProps({
    copy,
    isLoading: false,
    status: createStatus({
      actions: [
        { id: "login", kind: "terminal_command" },
        { id: "refresh", kind: "refresh" }
      ],
      availability: "auth_required"
    })
  });

  assert.deepEqual(props, {
    hoverActions: [
      { id: "login", label: "login" },
      { id: "refresh", label: "refresh" }
    ],
    state: {
      kind: "disabled",
      reason: "login required"
    }
  });
});

test("agent provider dock status shows unsupported providers as coming soon", () => {
  const props = resolveAgentProviderDockStatusProps({
    copy,
    isLoading: false,
    status: createStatus({
      actions: [{ id: "install", kind: "daemon_action" }],
      availability: "unsupported"
    })
  });

  assert.deepEqual(props, {
    state: {
      kind: "unavailable",
      reason: "coming soon"
    }
  });
});

function createStatus(input: {
  actions: AgentProviderStatus["actions"];
  availability: AgentProviderStatus["availability"]["status"];
}): AgentProviderStatus {
  return {
    actions: input.actions,
    adapter: {
      command: [],
      installed:
        input.availability !== "not_installed" &&
        input.availability !== "unsupported"
    },
    auth: {
      status: input.availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      status: input.availability
    },
    cli: {
      installed:
        input.availability !== "not_installed" &&
        input.availability !== "unsupported"
    },
    provider: "codex"
  };
}
