import { describe, expect, it } from "vitest";
import {
  deriveAgentSetupStages,
  projectRevealedStages,
  reasonCodeIndicatesCliVersionUnsupported,
  resolveWizardAutoStartAction,
  shouldAdvanceReveal,
  stageRemediation,
  type AgentSetupStage,
  type DeriveAgentSetupStagesInput
} from "./agentEnvWizardFlow";

describe("reasonCodeIndicatesCliVersionUnsupported", () => {
  it("does NOT flag the CLI for an adapter version mismatch", () => {
    // acp_adapter_version_mismatch contains "version" but is an ADAPTER problem;
    // it must not red the CLI step ("版本不受支持").
    expect(
      reasonCodeIndicatesCliVersionUnsupported("acp_adapter_version_mismatch")
    ).toBe(false);
  });

  it("flags genuine CLI-version reasons", () => {
    expect(
      reasonCodeIndicatesCliVersionUnsupported("codex_version_too_old")
    ).toBe(true);
    expect(
      reasonCodeIndicatesCliVersionUnsupported("cli_version_unsupported")
    ).toBe(true);
  });

  it("ignores non-version and empty reasons", () => {
    expect(
      reasonCodeIndicatesCliVersionUnsupported("acp_adapter_not_found")
    ).toBe(false);
    expect(reasonCodeIndicatesCliVersionUnsupported("")).toBe(false);
    expect(reasonCodeIndicatesCliVersionUnsupported(null)).toBe(false);
  });
});

const labels = {
  detect: "Detect",
  network: "Network",
  install: "Install",
  adapter: "Adapter",
  login: "Login",
  ready: "Ready"
};

function input(
  overrides: Partial<DeriveAgentSetupStagesInput> = {}
): DeriveAgentSetupStagesInput {
  return {
    detected: true,
    cliInstalled: false,
    versionTooOld: false,
    adapterInstalled: false,
    adapterVersionMismatch: false,
    authenticated: false,
    authRequired: false,
    ready: false,
    activePhase: null,
    installActionPending: false,
    loginPending: false,
    networkReachable: true,
    cliVersionDetail: null,
    adapterDetail: null,
    accountDetail: null,
    authMethod: null,
    networkDetail: null,
    labels,
    ...overrides
  };
}

describe("deriveAgentSetupStages", () => {
  it("renders the fixed 6-stage track in order", () => {
    const stages = deriveAgentSetupStages(input());
    expect(stages.map((s) => s.id)).toEqual([
      "detect",
      "network",
      "install",
      "adapter",
      "login",
      "ready"
    ]);
  });

  it("carries the cli version detail token on the install stage", () => {
    const stages = deriveAgentSetupStages({
      ...input(),
      detected: true,
      cliInstalled: true,
      cliVersionDetail: { kind: "text", text: "1.2.3 · /usr/bin/codex" }
    });
    const install = stages.find((s) => s.id === "install");
    expect(install).toBeDefined();
    expect(install?.detail).toEqual({
      kind: "text",
      text: "1.2.3 · /usr/bin/codex"
    });
  });

  it("shows detect running and the rest pending before status is known", () => {
    const stages = deriveAgentSetupStages(input({ detected: false }));
    expect(stages.map((s) => [s.id, s.status])).toEqual([
      ["detect", "running"],
      ["network", "pending"],
      ["install", "pending"],
      ["adapter", "pending"],
      ["login", "pending"],
      ["ready", "pending"]
    ]);
  });

  it("marks install and adapter running while the active phase is installing", () => {
    const stages = deriveAgentSetupStages(input({ activePhase: "install" }));
    expect(stage(stages, "detect").status).toBe("ok");
    expect(stage(stages, "install").status).toBe("running");
    expect(stage(stages, "adapter").status).toBe("running");
    expect(stage(stages, "login").status).toBe("pending");
  });

  it("flags install as error when the version is too old", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        versionTooOld: true,
        cliVersionDetail: { kind: "text", text: "0.100.0" }
      })
    );
    expect(stage(stages, "install").status).toBe("error");
    expect(stage(stages, "install").detail).toEqual({
      kind: "text",
      text: "0.100.0"
    });
  });

  it("flags install pending with a platform-incomplete problem when the launcher is present but the platform subpackage is missing", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        platformPackageIncomplete: true,
        cliVersionDetail: { kind: "text", text: "1.2.3 · /usr/bin/codex" }
      })
    );
    expect(stage(stages, "install").status).toBe("pending");
    expect(stage(stages, "install").problem).toBe(
      "install-platform-incomplete"
    );
  });

  it("marks install ok when ready even if the platform subpackage flag is set", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        platformPackageIncomplete: true,
        ready: true
      })
    );
    expect(stage(stages, "install").status).toBe("ok");
    expect(stage(stages, "install").problem).toBeUndefined();
  });

  it("marks adapter pending when CLI is installed but the adapter is missing", () => {
    const stages = deriveAgentSetupStages(
      input({ cliInstalled: true, adapterInstalled: false })
    );
    expect(stage(stages, "install").status).toBe("ok");
    expect(stage(stages, "adapter").status).toBe("pending");
  });

  it("shows the adapter running on a pending install action even without an activePhase (claude-code adapter installer emits no phase)", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        adapterInstalled: false,
        installActionPending: true,
        activePhase: null
      })
    );
    expect(stage(stages, "install").status).toBe("ok");
    expect(stage(stages, "adapter").status).toBe("running");
  });

  it("marks adapter ok and error from its own flags", () => {
    expect(
      stage(
        deriveAgentSetupStages(
          input({
            cliInstalled: true,
            adapterInstalled: true,
            adapterDetail: { kind: "text", text: "claude-acp" }
          })
        ),
        "adapter"
      )
    ).toMatchObject({
      status: "ok",
      detail: { kind: "text", text: "claude-acp" }
    });
    expect(
      stage(
        deriveAgentSetupStages(
          input({
            cliInstalled: true,
            adapterInstalled: true,
            adapterVersionMismatch: true
          })
        ),
        "adapter"
      ).status
    ).toBe("error");
  });

  it("marks login running while a login action is pending", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        adapterInstalled: true,
        authRequired: true,
        loginPending: true,
        cliVersionDetail: { kind: "text", text: "0.142.1" }
      })
    );
    expect(stage(stages, "install").status).toBe("ok");
    expect(stage(stages, "adapter").status).toBe("ok");
    expect(stage(stages, "login").status).toBe("running");
  });

  it("marks login pending (not error) when auth is required but install is not done", () => {
    const stages = deriveAgentSetupStages(input({ authRequired: true }));
    expect(stage(stages, "login").status).toBe("pending");
  });

  it("marks every stage ok when ready", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        adapterInstalled: true,
        authenticated: true,
        ready: true,
        activePhase: "done",
        cliVersionDetail: { kind: "text", text: "0.142.1" },
        accountDetail: { kind: "text", text: "user@example.com" },
        authMethod: "oauth"
      })
    );
    expect(stages.map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok"
    ]);
    expect(stage(stages, "login").detail).toEqual({
      kind: "text",
      text: "user@example.com"
    });
    expect(stage(stages, "login").authMethod).toBe("oauth");
  });

  it("carries authMethod on the login stage for API billing", () => {
    const stages = deriveAgentSetupStages(
      input({
        cliInstalled: true,
        adapterInstalled: true,
        authenticated: true,
        ready: true,
        accountDetail: { kind: "text", text: "API Usage Billing" },
        authMethod: "apiKey"
      })
    );
    expect(stage(stages, "login").authMethod).toBe("apiKey");
  });

  it("flags the network stage as error when connectivity is unreachable", () => {
    const stages = deriveAgentSetupStages(
      input({ networkReachable: false, networkDetail: null })
    );
    expect(stage(stages, "network").status).toBe("error");
    // A blocked network keeps the downstream install step pending, not running.
    expect(stage(stages, "install").status).toBe("pending");
  });

  it("shows the network stage ok with its registry detail when reachable", () => {
    const stages = deriveAgentSetupStages(
      input({
        networkReachable: true,
        networkDetail: { kind: "text", text: "registry.npmjs.org" }
      })
    );
    expect(stage(stages, "network")).toMatchObject({
      status: "ok",
      detail: { kind: "text", text: "registry.npmjs.org" }
    });
  });

  it("treats an unknown (null) network verdict as non-blocking", () => {
    const stages = deriveAgentSetupStages(input({ networkReachable: null }));
    expect(stage(stages, "network").status).toBe("ok");
  });
});

describe("projectRevealedStages / shouldAdvanceReveal", () => {
  const allOk: AgentSetupStage[] = [
    { id: "detect", label: "Detect", status: "ok", detail: null },
    { id: "install", label: "Install", status: "ok", detail: null },
    { id: "adapter", label: "Adapter", status: "ok", detail: null },
    { id: "login", label: "Login", status: "ok", detail: null },
    { id: "ready", label: "Ready", status: "ok", detail: null }
  ];

  it("shows revealed stages real, the cursor as running, and the rest pending", () => {
    const projected = projectRevealedStages(allOk, 2);
    expect(projected.map((s) => s.status)).toEqual([
      "ok", // 0 revealed
      "ok", // 1 revealed
      "running", // 2 cursor (real ok shown as working)
      "pending", // 3 not yet revealed
      "pending" // 4 not yet revealed
    ]);
  });

  it("advances past a really-ok cursor stage", () => {
    expect(shouldAdvanceReveal(allOk, 0)).toBe(true);
    expect(shouldAdvanceReveal(allOk, 4)).toBe(true);
  });

  it("stops advancing once the whole track is revealed", () => {
    expect(shouldAdvanceReveal(allOk, allOk.length)).toBe(false);
  });

  it("parks the cursor on a running, error, or pending stage", () => {
    const stages: AgentSetupStage[] = [
      { id: "detect", label: "Detect", status: "ok", detail: null },
      { id: "install", label: "Install", status: "running", detail: null },
      { id: "adapter", label: "Adapter", status: "pending", detail: null },
      { id: "login", label: "Login", status: "pending", detail: null },
      { id: "ready", label: "Ready", status: "pending", detail: null }
    ];
    expect(shouldAdvanceReveal(stages, 1)).toBe(false); // running install
    // the cursor stage shows its real (running) status, not a synthetic one
    expect(stage(projectRevealedStages(stages, 1), "install").status).toBe(
      "running"
    );
    const errored: AgentSetupStage[] = [
      { id: "detect", label: "Detect", status: "ok", detail: null },
      { id: "install", label: "Install", status: "error", detail: null }
    ];
    expect(shouldAdvanceReveal(errored, 1)).toBe(false);
    expect(stage(projectRevealedStages(errored, 1), "install").status).toBe(
      "error"
    );
  });
});

describe("stageRemediation", () => {
  const mk = (
    id: AgentSetupStage["id"],
    status: AgentSetupStage["status"]
  ): AgentSetupStage => ({ id, label: id, status, detail: null });

  it("returns null for ok or running stages", () => {
    expect(stageRemediation(mk("install", "ok"))).toBeNull();
    expect(stageRemediation(mk("install", "running"))).toBeNull();
    expect(stageRemediation(mk("login", "ok"))).toBeNull();
  });

  it("returns null for detect and ready (prerequisite stages, not user actions)", () => {
    expect(stageRemediation(mk("detect", "pending"))).toBeNull();
    expect(stageRemediation(mk("ready", "pending"))).toBeNull();
  });

  it("maps an unreachable network to a re-detect remediation", () => {
    expect(stageRemediation(mk("network", "error"))).toEqual({
      actionId: "redetect",
      problem: "network-unreachable"
    });
  });

  it("maps a pending install to install-missing → install", () => {
    expect(stageRemediation(mk("install", "pending"))).toEqual({
      actionId: "install",
      problem: "install-missing"
    });
  });

  it("maps an errored install to install-outdated → redetect (manual upgrade, not auto-install)", () => {
    expect(stageRemediation(mk("install", "error"))).toEqual({
      actionId: "redetect",
      problem: "install-outdated"
    });
  });

  it("maps a platform-incomplete install to install-platform-incomplete → install (daemon repairs in place)", () => {
    expect(
      stageRemediation({
        id: "install",
        label: "install",
        status: "pending",
        detail: null,
        problem: "install-platform-incomplete"
      })
    ).toEqual({
      actionId: "install",
      problem: "install-platform-incomplete"
    });
  });

  it("maps the adapter stage to adapter problems, fixed by install", () => {
    expect(stageRemediation(mk("adapter", "pending"))).toEqual({
      actionId: "install",
      problem: "adapter-missing"
    });
    expect(stageRemediation(mk("adapter", "error"))).toEqual({
      actionId: "install",
      problem: "adapter-mismatch"
    });
  });

  it("maps a pending login to login-missing → login", () => {
    expect(stageRemediation(mk("login", "pending"))).toEqual({
      actionId: "login",
      problem: "login-missing"
    });
  });
});

describe("resolveWizardAutoStartAction", () => {
  const base = {
    detected: true,
    ready: false,
    installPending: false,
    loginPending: false
  };

  it("returns install for install/repair focus", () => {
    expect(resolveWizardAutoStartAction({ ...base, focus: "install" })).toBe(
      "install"
    );
    expect(resolveWizardAutoStartAction({ ...base, focus: "repair" })).toBe(
      "install"
    );
  });

  it("does NOT auto-start install for upgrade focus (CLI upgrades are user-driven)", () => {
    expect(
      resolveWizardAutoStartAction({ ...base, focus: "upgrade" })
    ).toBeNull();
  });

  it("returns login for auth focus", () => {
    expect(resolveWizardAutoStartAction({ ...base, focus: "auth" })).toBe(
      "login"
    );
  });

  it("returns null for non-remediation focus", () => {
    expect(
      resolveWizardAutoStartAction({ ...base, focus: "detect" })
    ).toBeNull();
    expect(
      resolveWizardAutoStartAction({ ...base, focus: "network" })
    ).toBeNull();
    expect(
      resolveWizardAutoStartAction({ ...base, focus: "registry" })
    ).toBeNull();
    expect(resolveWizardAutoStartAction({ ...base, focus: null })).toBeNull();
  });

  it("returns null until detection has settled", () => {
    expect(
      resolveWizardAutoStartAction({
        ...base,
        detected: false,
        focus: "install"
      })
    ).toBeNull();
  });

  it("returns null when already ready", () => {
    expect(
      resolveWizardAutoStartAction({ ...base, ready: true, focus: "auth" })
    ).toBeNull();
  });

  it("returns null when the matching action is already pending", () => {
    expect(
      resolveWizardAutoStartAction({
        ...base,
        focus: "install",
        installPending: true
      })
    ).toBeNull();
    expect(
      resolveWizardAutoStartAction({
        ...base,
        focus: "auth",
        loginPending: true
      })
    ).toBeNull();
  });
});

function stage(stages: AgentSetupStage[], id: string) {
  const found = stages.find((s) => s.id === id);
  if (!found) {
    throw new Error(`stage ${id} not found`);
  }
  return found;
}
