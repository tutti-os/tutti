import { describe, expect, it } from "vitest";
import {
  buildAgentEnvWizardViewModel,
  deriveHasAnomaly,
  type AgentEnvWizardViewModelInput
} from "./agentEnvViewModel";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";

const LABELS = {
  detect: "检测",
  network: "网络",
  install: "安装",
  adapter: "适配器",
  login: "登录",
  ready: "就绪"
};

function status(
  overrides: Partial<AgentProviderStatus> = {}
): AgentProviderStatus {
  return {
    provider: "codex",
    availability: { status: "ready", reasonCode: null },
    cli: {
      installed: true,
      binaryPath: "/usr/bin/codex",
      version: "1.2.3",
      minVersion: "1.0.0"
    },
    adapter: {
      installed: true,
      binaryPath: "/opt/acp",
      command: ["acp"],
      version: "2.0.0",
      requiredVersion: "2.0.0"
    },
    auth: {
      status: "authenticated",
      accountLabel: "me@x.com",
      authMethod: "oauth"
    },
    actions: [],
    network: null,
    activeAction: null,
    ...overrides
  } as AgentProviderStatus;
}

function input(
  overrides: Partial<AgentEnvWizardViewModelInput> = {}
): AgentEnvWizardViewModelInput {
  return {
    provider: "codex",
    status: status(),
    isLoading: false,
    activeAction: null,
    installActionPending: false,
    updateActionPending: false,
    loginPending: false,
    revealIndex: Number.MAX_SAFE_INTEGER,
    stageLabels: LABELS,
    ...overrides
  };
}

describe("buildAgentEnvWizardViewModel", () => {
  it("marks ready and all stages ok for a fully-configured provider", () => {
    const vm = buildAgentEnvWizardViewModel(input());
    expect(vm.ready).toBe(true);
    expect(vm.displayStages.every((s) => s.status === "ok")).toBe(true);
    expect(vm.blockingStageId).toBeNull();
  });

  it("projects a discovered update and keeps the CLI stage busy while it runs", () => {
    const updateStatus = status({
      actions: [{ id: "update", kind: "daemon_action" }],
      update: {
        capability: "supported",
        source: "npm",
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: true,
        unsupportedReason: null,
        lastCheckedAt: "2026-07-19T00:00:00Z",
        reasonCode: null
      }
    });
    const available = buildAgentEnvWizardViewModel(
      input({ status: updateStatus })
    );
    expect(available.updateAvailable).toBe(true);

    const pending = buildAgentEnvWizardViewModel(
      input({ status: updateStatus, updateActionPending: true })
    );
    expect(pending.busy).toBe(true);
    expect(pending.updating).toBe(true);
    expect(
      pending.displayStages.find((stage) => stage.id === "install")?.status
    ).toBe("running");
  });

  it("shows the version-floor token when the CLI is below the supported floor", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: {
            status: "unsupported",
            reasonCode: "codex_version_too_old"
          },
          cli: {
            installed: true,
            version: "0.9.0",
            minVersion: "1.0.0",
            binaryPath: "/usr/bin/codex"
          }
        }),
        revealIndex: Number.MAX_SAFE_INTEGER
      })
    );
    const install = vm.displayStages.find((s) => s.id === "install");
    expect(install?.detail).toEqual({
      kind: "version-floor",
      current: "0.9.0",
      required: "1.0.0"
    });
    expect(install?.status).toBe("error");
  });

  it("shows the version-floor token for a generic provider version gate", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: {
            status: "not_installed",
            reasonCode: "cli_version_unsupported"
          },
          cli: {
            installed: true,
            version: "0.0.2",
            minVersion: "0.0.4",
            binaryPath: "/usr/bin/tutti-agent"
          }
        }),
        revealIndex: Number.MAX_SAFE_INTEGER
      })
    );
    const install = vm.displayStages.find((s) => s.id === "install");
    expect(install?.detail).toEqual({
      kind: "version-floor",
      current: "0.0.2",
      required: "0.0.4"
    });
    expect(install?.status).toBe("error");
  });

  it("does NOT red the install (CLI) stage on an adapter version mismatch", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: {
            status: "unsupported",
            reasonCode: "acp_adapter_version_mismatch"
          },
          adapter: {
            installed: true,
            version: "1.0.0",
            requiredVersion: "2.0.0",
            command: ["acp"],
            binaryPath: "/opt/acp"
          }
        })
      })
    );
    expect(vm.displayStages.find((s) => s.id === "install")?.status).toBe("ok");
    const adapter = vm.displayStages.find((s) => s.id === "adapter");
    expect(adapter?.status).toBe("error");
    expect(adapter?.detail).toEqual({
      kind: "version-mismatch",
      current: "1.0.0",
      required: "2.0.0"
    });
  });

  it("shows installed and required Tutti Agent adapter versions on mismatch", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        provider: "tutti-agent",
        status: status({
          provider: "tutti-agent",
          availability: {
            status: "not_installed",
            reasonCode: "acp_adapter_version_mismatch"
          },
          adapter: {
            installed: false,
            version: "0.0.1",
            requiredVersion: "0.0.3",
            command: ["tutti-agent", "app-server"],
            binaryPath: "/opt/tutti-agent"
          }
        })
      })
    );
    const adapter = vm.displayStages.find((s) => s.id === "adapter");
    expect(adapter?.status).toBe("error");
    expect(adapter?.detail).toEqual({
      kind: "version-mismatch",
      current: "0.0.1",
      required: "0.0.3"
    });
  });

  it("assembles network checks and treats an unconfigured proxy as reachable", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          network: {
            registry: {
              reachable: true,
              endpoint: "https://registry.npmjs.org"
            },
            providerApi: {
              reachable: false,
              endpoint: "https://api.openai.com/v1"
            },
            proxy: { configured: false, reachable: false, url: null }
          }
        })
      })
    );
    expect(vm.networkChecks).toEqual([
      { kind: "registry", reachable: true, host: "registry.npmjs.org" },
      { kind: "api", reachable: false, host: "api.openai.com" },
      { kind: "proxy", reachable: true, host: null, configured: false }
    ]);
  });

  it("strips credentials from a configured proxy URL", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          network: {
            registry: {
              reachable: true,
              endpoint: "https://registry.npmjs.org"
            },
            proxy: {
              configured: true,
              reachable: true,
              url: "http://user:s3cr3t@proxy.corp:8080"
            }
          }
        })
      })
    );
    const proxy = vm.networkChecks.find((c) => c.kind === "proxy");
    expect(proxy?.host).toBe("http://proxy.corp:8080");
    expect(proxy?.host).not.toContain("s3cr3t");
  });

  it("surfaces the first non-ok stage as blocking once revealed", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: { status: "auth_required", reasonCode: null },
          auth: { status: "required", accountLabel: null, authMethod: null }
        })
      })
    );
    expect(vm.blockingStageId).toBe("login");
  });

  it("hides the blocking stage when the reveal cursor has not reached it", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          auth: { status: "required", accountLabel: null, authMethod: null },
          availability: { status: "auth_required", reasonCode: null }
        }),
        revealIndex: 0
      })
    );
    expect(vm.blockingStageId).toBeNull();
  });

  it("exposes the manual install command for codex", () => {
    expect(buildAgentEnvWizardViewModel(input()).manualCommand).toBe(
      "npm install -g @openai/codex --include=optional"
    );
  });

  it("exposes the daemon-matching manual install command for claude code", () => {
    expect(
      buildAgentEnvWizardViewModel(input({ provider: "claude-code" }))
        .manualCommand
    ).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });

  it("flags the install stage pending with a platform-incomplete problem when the launcher is present but the platform subpackage is missing", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: {
            status: "not_installed",
            reasonCode: "codex_platform_pkg_incomplete"
          },
          // The launcher itself is resolved, so without the platform-incomplete
          // signal the install stage would wrongly read as ok.
          cli: {
            installed: true,
            version: "1.2.3",
            minVersion: "1.0.0",
            binaryPath: "/usr/bin/codex"
          }
        })
      })
    );
    const install = vm.displayStages.find((s) => s.id === "install");
    expect(install?.status).toBe("pending");
    expect(install?.problem).toBe("install-platform-incomplete");
    expect(vm.ready).toBe(false);
  });
});

describe("deriveHasAnomaly", () => {
  it("is true when any stage is in error", () => {
    expect(
      deriveHasAnomaly(
        [{ id: "adapter", label: "x", status: "error", detail: null }],
        null
      )
    ).toBe(true);
  });
  it("is true when the active action carries an error", () => {
    expect(
      deriveHasAnomaly(
        [{ id: "ready", label: "x", status: "ok", detail: null }],
        { code: "boom", message: "failed" }
      )
    ).toBe(true);
  });
  it("is false for a clean not-yet-set-up flow", () => {
    expect(
      deriveHasAnomaly(
        [{ id: "login", label: "x", status: "pending", detail: null }],
        null
      )
    ).toBe(false);
  });
});
