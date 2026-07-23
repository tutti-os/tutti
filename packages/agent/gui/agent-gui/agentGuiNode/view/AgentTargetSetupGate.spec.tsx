import { useEffect, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import {
  resetAgentHostApiForTests,
  setAgentHostApiForTests
} from "../../../agentActivityHost.tsx";
import type {
  AgentHostAgentTargetSetupSnapshot,
  AgentHostAgentTargetSetupState,
  AgentHostAgentTargetSetupWatch,
  AgentHostInputApi
} from "../../../host/agentHostApi.ts";
import {
  AgentTargetSetupControllerProvider,
  useCreateAgentTargetSetupController
} from "../../../shared/agentEnv/agentTargetSetupController.tsx";
import type { AgentGUIAgentTarget } from "../../../types.ts";
import {
  AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY,
  serializeAgentGUIProviderRailPreferences
} from "../model/agentGuiProviderRailOrder.ts";
import { AgentTargetSetupGate } from "./AgentTargetSetupGate.tsx";
import {
  AgentTargetSetupRoot,
  useAgentTargetSetupRoot
} from "./AgentTargetSetupRoot.tsx";

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
});

afterEach(() => {
  cleanup();
  resetAgentHostApiForTests();
  globalThis.localStorage?.removeItem(
    AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY
  );
});

const codebuddyTarget = target("codebuddy", "CodeBuddy Code");
const geminiTarget = target("gemini", "Gemini CLI");

describe("AgentTargetSetupGate", () => {
  it("gates while checking, then reveals the composer when ready", async () => {
    const setup = createWatch({ snapshot: null, loading: true, failed: false });
    installHost(new Map([["extension:codebuddy", setup.watch]]));

    render(<Harness target={codebuddyTarget} />);

    expect(screen.queryByText("composer ready")).toBeNull();
    expect(
      screen.getByText("Checking local and Tutti-managed runtimes…")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open setup" })).toBeNull();

    act(() => setup.publish(ready("extension:codebuddy")));

    expect(await screen.findByText("composer ready")).toBeTruthy();
    expect(setup.subscribe).toHaveBeenCalledTimes(1);
  });

  it("shows the signed-in account and reauthenticates with its method", async () => {
    const authenticate =
      vi.fn<AgentHostAgentTargetSetupWatch["authenticate"]>();
    const setup = createWatch(
      {
        snapshot: {
          ...ready("extension:codebuddy"),
          authMethods: [
            { id: "iOA", name: "Login with iOA" },
            { id: "external", name: "Login with Google/GitHub" }
          ],
          account: {
            id: "user-1",
            displayName: "Rhinoc",
            authMethodId: "iOA",
            organization: "Tutti"
          }
        },
        loading: false,
        failed: false
      },
      { authenticate }
    );
    installHost(new Map([["extension:codebuddy", setup.watch]]));

    render(<Harness openDialog target={codebuddyTarget} />);

    expect(await screen.findByText("Signed-in account")).toBeTruthy();
    expect(screen.getByText("Rhinoc · Tutti")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("CodeBuddy Code is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(authenticate).toHaveBeenCalledTimes(1));
    expect(authenticate.mock.calls[0]?.[0]).toMatchObject({ methodId: "iOA" });
  });

  it("installs from the shared dialog and can reopen after dismissal", async () => {
    const install = vi.fn<AgentHostAgentTargetSetupWatch["install"]>();
    const setup = createWatch(notInstalled("extension:codebuddy"), { install });
    installHost(new Map([["extension:codebuddy", setup.watch]]));
    render(<Harness target={codebuddyTarget} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open setup" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Install runtime" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(install.mock.calls[0]?.[0]).toMatchObject({
      planDigest: "a".repeat(64)
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open setup" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("reinstalls from a persisted failed install action", async () => {
    const install = vi.fn<AgentHostAgentTargetSetupWatch["install"]>();
    const setup = createWatch(failedInstall("extension:codebuddy"), {
      install
    });
    installHost(new Map([["extension:codebuddy", setup.watch]]));

    render(<Harness openDialog target={codebuddyTarget} />);

    expect(await screen.findByText("Runtime setup failed")).toBeTruthy();
    expect(screen.getByText("fixture install failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reinstall runtime" }));

    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(install.mock.calls[0]?.[0]).toMatchObject({
      planDigest: "a".repeat(64)
    });
    expect(install.mock.calls[0]?.[0].clientActionId).not.toBe(
      "failed-client-action"
    );
  });

  it("authenticates with the selected method and renders action errors", async () => {
    const authenticate =
      vi.fn<AgentHostAgentTargetSetupWatch["authenticate"]>();
    const setup = createWatch(authRequired("extension:gemini"), {
      authenticate
    });
    installHost(new Map([["extension:gemini", setup.watch]]));
    render(<Harness target={geminiTarget} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open setup" }));
    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Sign-in method" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Gemini API key" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to sign in" })
    );
    await waitFor(() => expect(authenticate).toHaveBeenCalledTimes(1));
    expect(authenticate.mock.calls[0]?.[0]).toMatchObject({
      methodId: "gemini-api-key"
    });

    act(() =>
      setup.publish({
        ...authRequired("extension:gemini").snapshot!,
        action: {
          actionId: "auth-1",
          clientActionId: "client-auth-1",
          kind: "authenticate",
          status: "failed",
          phase: "complete",
          errorCode: "authentication_failed",
          errorMessage: "This account is not supported by this client"
        }
      })
    );
    expect(
      await screen.findByText("Authentication did not complete")
    ).toBeTruthy();
    expect(
      screen.getByText("This account is not supported by this client")
    ).toBeTruthy();
  });

  it("guides terminal sign-in methods with a copyable command instead of ACP authenticate", async () => {
    const authenticate =
      vi.fn<AgentHostAgentTargetSetupWatch["authenticate"]>();
    const setup = createWatch(
      {
        snapshot: {
          ...authRequired("extension:gemini").snapshot!,
          authMethods: [
            {
              id: "login",
              name: "Login with Kimi account",
              type: "terminal",
              terminalCommand: "/opt/kimi-code/bin/kimi login"
            }
          ]
        },
        loading: false,
        failed: false
      },
      { authenticate }
    );
    installHost(new Map([["extension:gemini", setup.watch]]));
    render(<Harness openDialog target={geminiTarget} />);

    expect(
      await screen.findByText("/opt/kimi-code/bin/kimi login")
    ).toBeTruthy();
    expect(screen.getByText(/must be completed in a terminal/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue to sign in" })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(authenticate).not.toHaveBeenCalled();
  });

  function terminalLoginSetup(
    overrides: Partial<AgentHostAgentTargetSetupWatch> = {}
  ) {
    return createWatch(
      {
        snapshot: {
          ...authRequired("extension:gemini").snapshot!,
          authMethods: [
            {
              id: "login",
              name: "Login with Kimi account",
              type: "terminal",
              terminalCommand: "/opt/kimi-code/bin/kimi login"
            }
          ]
        },
        loading: false,
        failed: false
      },
      overrides
    );
  }

  it("launches an in-app terminal for terminal sign-in and closes it once ready", async () => {
    const close = vi.fn();
    const run = vi.fn(async (_input: { command: string; cwd?: string }) => ({
      close
    }));
    const setup = terminalLoginSetup();
    installHost(new Map([["extension:gemini", setup.watch]]), {
      terminalLogin: { run }
    });
    render(<Harness openDialog target={geminiTarget} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Start sign in" })
    );
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]?.[0]).toEqual({
      command: "/opt/kimi-code/bin/kimi login"
    });
    expect(
      await screen.findByText(/terminal has been opened in the workspace/)
    ).toBeTruthy();

    act(() => setup.publish(ready("extension:gemini")));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("cancels a waiting terminal sign-in and closes the terminal", async () => {
    const close = vi.fn();
    const run = vi.fn(async (_input: { command: string; cwd?: string }) => ({
      close
    }));
    const setup = terminalLoginSetup();
    installHost(new Map([["extension:gemini", setup.watch]]), {
      terminalLogin: { run }
    });
    render(<Harness openDialog target={geminiTarget} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Start sign in" })
    );
    expect(
      await screen.findByText(/terminal has been opened in the workspace/)
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/terminal has been opened in the workspace/)
    ).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Start sign in" })
    ).toBeTruthy();
  });

  it("keeps the copy fallback when the terminal cannot be launched", async () => {
    const run = vi.fn(async () => {
      throw new Error("Terminal login is unavailable in this window.");
    });
    const setup = terminalLoginSetup();
    installHost(new Map([["extension:gemini", setup.watch]]), {
      terminalLogin: { run }
    });
    render(<Harness openDialog target={geminiTarget} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Start sign in" })
    );
    expect(
      await screen.findByText(/could not be opened in this window/)
    ).toBeTruthy();
    expect(screen.getByText("/opt/kimi-code/bin/kimi login")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  it("resets dialog and auth selection when the target changes", async () => {
    const gemini = createWatch(authRequired("extension:gemini"));
    const codebuddy = createWatch({
      snapshot: {
        ...authRequired("extension:codebuddy").snapshot!,
        authMethods: [{ id: "browser-login", name: "Browser login" }]
      },
      loading: false,
      failed: false
    });
    installHost(
      new Map([
        ["extension:gemini", gemini.watch],
        ["extension:codebuddy", codebuddy.watch]
      ])
    );
    const view = render(<Harness target={geminiTarget} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open setup" }));
    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Sign-in method" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" }
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Gemini API key" })
    );

    view.rerender(<Harness target={codebuddyTarget} />);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(gemini.unsubscribe).toHaveBeenCalledTimes(1);
    expect(codebuddy.subscribe).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open setup" }));
    expect(
      await screen.findByRole("combobox", { name: "Sign-in method" })
    ).toHaveTextContent("Browser login");
  });

  it("uses the same fallback target for the hidden home selection and setup controller", async () => {
    globalThis.localStorage?.setItem(
      AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY,
      serializeAgentGUIProviderRailPreferences({
        hiddenTargetIds: [geminiTarget.targetId],
        order: [geminiTarget.targetId, codebuddyTarget.targetId]
      })
    );
    const codebuddy = createWatch(notInstalled("extension:codebuddy"));
    const gemini = createWatch({
      snapshot: ready("extension:gemini"),
      loading: false,
      failed: false
    });
    const hostWatch = installHost(
      new Map([
        ["extension:codebuddy", codebuddy.watch],
        ["extension:gemini", gemini.watch]
      ])
    );

    render(<RootHarness />);

    expect(screen.getByTestId("projected-home-target")).toHaveTextContent(
      "CodeBuddy Code"
    );
    expect(await screen.findByText("Set up CodeBuddy Code")).toBeTruthy();
    expect(hostWatch).toHaveBeenCalledTimes(1);
    expect(hostWatch).toHaveBeenCalledWith({
      agentTargetId: "extension:codebuddy"
    });
  });
});

function RootHarness(): React.JSX.Element {
  const { controller, homeTargetProjection } = useAgentTargetSetupRoot({
    activeConversationId: null,
    agentTargets: [geminiTarget, codebuddyTarget],
    environmentProvider: geminiTarget.provider,
    selectedAgentTarget: geminiTarget
  });
  return (
    <AgentTargetSetupRoot controller={controller}>
      <div data-testid="projected-home-target">
        {homeTargetProjection.selectedAgentTarget?.label}
      </div>
      <AgentTargetSetupGate carouselMountedExternally={false}>
        <div>composer ready</div>
      </AgentTargetSetupGate>
    </AgentTargetSetupRoot>
  );
}

function Harness({
  target: selectedTarget,
  children = <div>composer ready</div>,
  openDialog = false
}: {
  target: AgentGUIAgentTarget;
  children?: ReactNode;
  openDialog?: boolean;
}): React.JSX.Element {
  const controller = useCreateAgentTargetSetupController(selectedTarget);
  useEffect(() => {
    if (openDialog) controller.setDialogOpen(true);
  }, [controller, openDialog]);
  return (
    <AgentTargetSetupControllerProvider controller={controller}>
      <AgentTargetSetupGate carouselMountedExternally={false}>
        {children}
      </AgentTargetSetupGate>
      <AgentTargetSetupGate
        carouselMountedExternally={false}
        dialogOwner
        gateVisible={false}
      />
    </AgentTargetSetupControllerProvider>
  );
}

function createWatch(
  initial: AgentHostAgentTargetSetupState,
  overrides: Partial<AgentHostAgentTargetSetupWatch> = {}
) {
  let state = initial;
  const listeners = new Set<(state: AgentHostAgentTargetSetupState) => void>();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(
    (listener: (state: AgentHostAgentTargetSetupState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }
  );
  const watch: AgentHostAgentTargetSetupWatch = {
    getSnapshot: () => state,
    subscribe,
    install: async () => undefined,
    authenticate: async () => undefined,
    refresh: async () => undefined,
    ...overrides
  };
  return {
    publish(snapshot: AgentHostAgentTargetSetupSnapshot) {
      state = { snapshot, loading: false, failed: false };
      for (const listener of listeners) listener(state);
    },
    subscribe,
    unsubscribe,
    watch
  };
}

function installHost(
  watches: Map<string, AgentHostAgentTargetSetupWatch>,
  extra?: { terminalLogin?: AgentHostInputApi["terminalLogin"] }
) {
  const watch = vi.fn(({ agentTargetId }: { agentTargetId: string }) => {
    const targetWatch = watches.get(agentTargetId);
    if (!targetWatch) throw new Error(`Missing watch for ${agentTargetId}`);
    return targetWatch;
  });
  const api: AgentHostInputApi = {
    agentTargetSetup: { watch },
    clipboard: { writeText: async () => undefined },
    ...(extra?.terminalLogin ? { terminalLogin: extra.terminalLogin } : {}),
    filesystem: { readFileText: async () => ({ content: "" }) },
    workspace: {
      ensureDirectory: async () => undefined,
      readFile: async () => ({ bytes: new Uint8Array() }),
      selectDirectory: async () => null,
      selectFiles: async () => [],
      writeFileText: async () => undefined
    }
  };
  setAgentHostApiForTests(api);
  return watch;
}

function target(id: string, label: string): AgentGUIAgentTarget {
  return {
    targetId: `extension:${id}`,
    agentTargetId: `extension:${id}`,
    provider: `acp:${id}`,
    ref: {
      kind: "agent-directory",
      provider: `acp:${id}`,
      setupKind: "target_runtime"
    },
    label
  };
}

function ready(agentTargetId: string): AgentHostAgentTargetSetupSnapshot {
  return {
    agentTargetId,
    status: "ready",
    authMethods: [],
    account: null,
    runtimeSource: "managed",
    runtimeVersion: "1.0.0",
    reason: null,
    plan: null,
    action: null
  };
}

function notInstalled(agentTargetId: string): AgentHostAgentTargetSetupState {
  return {
    snapshot: {
      agentTargetId,
      status: "not_installed",
      authMethods: [],
      account: null,
      runtimeSource: null,
      runtimeVersion: null,
      reason: null,
      plan: {
        packageName: "@tutti-os/example-agent",
        packageVersion: "1.0.0",
        runner: "npm",
        installRoot: "/state/agent/runtimes/example/1.0.0",
        planDigest: "a".repeat(64)
      },
      action: null
    },
    loading: false,
    failed: false
  };
}

function authRequired(agentTargetId: string): AgentHostAgentTargetSetupState {
  return {
    snapshot: {
      agentTargetId,
      status: "auth_required",
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google" },
        { id: "gemini-api-key", name: "Gemini API key" }
      ],
      account: null,
      runtimeSource: "managed",
      runtimeVersion: "1.0.0",
      reason: null,
      plan: null,
      action: null
    },
    loading: false,
    failed: false
  };
}

function failedInstall(agentTargetId: string): AgentHostAgentTargetSetupState {
  return {
    snapshot: {
      ...notInstalled(agentTargetId).snapshot!,
      status: "failed",
      reason: "install_failed",
      action: {
        actionId: "failed-install-action",
        clientActionId: "failed-client-action",
        kind: "install",
        status: "failed",
        phase: "complete",
        errorCode: "install_failed",
        errorMessage: "fixture install failed"
      }
    },
    loading: false,
    failed: false
  };
}
