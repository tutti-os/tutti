import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderActionRunResponse,
  AgentProviderStatus,
  AgentProviderStatusListResponse,
  AgentProviderProbeResponse,
  AgentProviderTerminalCommand,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import { DesktopAgentProviderStatusService } from "./desktopAgentProviderStatusService.ts";

function legacyAgentEvents(
  events: readonly ReporterEventInput[]
): ReporterEventInput[] {
  return events
    .filter((event) => event.name !== "agent.node_result")
    .map(stripAgentAnalyticsErrorFields);
}

function stripAgentAnalyticsErrorFields(
  event: ReporterEventInput
): ReporterEventInput {
  if (!event.name.startsWith("agent.")) {
    return event;
  }
  const eventParams = event.params ?? {};
  const {
    error_code: _errorCode,
    error_message: _errorMessage,
    ...params
  } = eventParams;
  return { ...event, params };
}

test("runAction executes terminal commands and refreshes the provider status", async () => {
  const commands: AgentProviderTerminalCommand[] = [];
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const pendingSnapshots: boolean[] = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [
              {
                command: {
                  cwd: "/workspace",
                  input: "codex login\n"
                },
                id: "login",
                kind: "terminal_command"
              }
            ],
            availability: "auth_required"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand(command) {
        commands.push(command);
      }
    }
  });
  service.subscribe(() => {
    pendingSnapshots.push(service.isActionPending("codex", "login"));
  });

  await service.refresh();
  await service.runAction("codex", "login", { workspaceId: "workspace-1" });

  assert.deepEqual(commands, [
    {
      cwd: "/workspace",
      input: "codex login\n"
    }
  ]);
  assert.deepEqual(statusCalls, [undefined, ["codex"]]);
  assert.equal(pendingSnapshots.includes(true), false);
});

test("refresh sends includeNetwork only when the caller opts in", async () => {
  const includeNetworkRequests: Array<boolean | undefined> = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onStatusRequest: (_providers, includeNetwork) => {
        includeNetworkRequests.push(includeNetwork);
      },
      snapshots: [
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ]),
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  // Dock / default poll → local-only (no flag); wizard → opts in.
  await service.refresh(["codex"]);
  await service.refresh(["codex"], { includeNetwork: true });

  assert.deepEqual(includeNetworkRequests, [undefined, true]);
});

test("a local-only refresh keeps the network the wizard fetched", async () => {
  const network = {
    registry: { reachable: true, endpoint: "https://registry.npmjs.org" },
    providerApi: { reachable: true, endpoint: "https://api.openai.com/v1" },
    proxy: { configured: false, reachable: false }
  };
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        // Wizard fetch (with network).
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready", network })
        ]),
        // Dock / poll fetch (local-only, no network).
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh(["codex"], { includeNetwork: true });
  assert.deepEqual(service.getStatus("codex")?.network, network);

  // A later local-only poll omits network; it must not wipe the diagnostic.
  await service.refresh(["codex"]);
  assert.deepEqual(service.getStatus("codex")?.network, network);
});

test("runAction tracks provider login initiation and successful status result", async () => {
  const events: ReporterEventInput[] = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [
              {
                command: {
                  cwd: "/workspace",
                  input: "codex login\n"
                },
                id: "login",
                kind: "terminal_command"
              }
            ],
            availability: "auth_required"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready"
          })
        ])
      ]
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(nextEvents) {
        // These tests focus on the login/ready funnel; the always-on
        // env_detected event is verified separately.
        events.push(
          ...legacyAgentEvents(nextEvents).filter(
            (event) => event.name !== "agent.env_detected"
          )
        );
      }
    },
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.runAction("codex", "login", { workspaceId: "workspace-1" });
  await flushAsyncWork();
  await waitFor(() =>
    events.some((event) => event.name === "agent.provider_login_result")
  );

  assert.deepEqual(
    events.map((event) => event.name),
    [
      "agent.provider_login_initiated",
      "agent.provider_ready",
      "agent.provider_login_result"
    ]
  );
  assert.deepEqual(events[0], {
    clientTS: 1749124800000,
    name: "agent.provider_login_initiated",
    params: {
      provider: "codex"
    }
  });
  assert.deepEqual(events[1], {
    clientTS: 1749124800000,
    name: "agent.provider_ready",
    params: {
      became_ready_via: "login",
      previous_status: "auth_required",
      provider: "codex"
    }
  });
  assert.equal(events[2]?.clientTS, 1749124800000);
  assert.equal(events[2]?.params?.error_reason, null);
  assert.equal(events[2]?.params?.provider, "codex");
  assert.equal(events[2]?.params?.success, true);
});

test("runAction auto-closes the login terminal once login succeeds", async () => {
  let closed = 0;
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [
              {
                command: { cwd: "/workspace", input: "codex login\n" },
                id: "login",
                kind: "terminal_command"
              }
            ],
            availability: "auth_required"
          })
        ]),
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ])
      ]
    }),
    reporterNow: () => 1749124800000,
    reporterService: { async trackEvents() {} },
    terminalCommandRunner: {
      async runTerminalCommand() {
        return {
          close: () => {
            closed += 1;
          }
        };
      }
    }
  });

  await service.refresh();
  await service.runAction("codex", "login", { workspaceId: "workspace-1" });
  await flushAsyncWork();

  assert.equal(closed, 1);
});

test("runAction keeps the login terminal open when login never completes", async () => {
  let closed = 0;
  const authRequired = createProviderStatus({
    actions: [
      {
        command: { cwd: "/workspace", input: "codex login\n" },
        id: "login",
        kind: "terminal_command"
      }
    ],
    availability: "auth_required"
  });
  const service = new DesktopAgentProviderStatusService({
    loginStatusPollScheduler: createManualPollScheduler().scheduler,
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([authRequired]),
        createStatusResponse([authRequired])
      ]
    }),
    reporterNow: () => 1749124800000,
    reporterService: { async trackEvents() {} },
    terminalCommandRunner: {
      async runTerminalCommand() {
        return {
          close: () => {
            closed += 1;
          }
        };
      }
    }
  });

  await service.refresh();
  await service.runAction("codex", "login", { workspaceId: "workspace-1" });
  await flushAsyncWork();

  assert.equal(closed, 0);
});

test("requestStatuses reports an already-ready provider as an activation signal", async () => {
  const events: ReporterEventInput[] = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready"
          })
        ])
      ]
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(nextEvents) {
        // These tests focus on the login/ready funnel; the always-on
        // env_detected event is verified separately.
        events.push(
          ...legacyAgentEvents(nextEvents).filter(
            (event) => event.name !== "agent.env_detected"
          )
        );
      }
    },
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await flushAsyncWork();

  assert.deepEqual(events, [
    {
      clientTS: 1749124800000,
      name: "agent.provider_ready",
      params: {
        became_ready_via: "already_ready",
        previous_status: "absent",
        provider: "codex"
      }
    }
  ]);
});

test("requestStatuses does not re-report a provider that was already ready", async () => {
  const events: ReporterEventInput[] = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ]),
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ])
      ]
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(nextEvents) {
        // These tests focus on the login/ready funnel; the always-on
        // env_detected event is verified separately.
        events.push(
          ...legacyAgentEvents(nextEvents).filter(
            (event) => event.name !== "agent.env_detected"
          )
        );
      }
    },
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh();
  await flushAsyncWork();

  assert.deepEqual(events, [
    {
      clientTS: 1749124800000,
      name: "agent.provider_ready",
      params: {
        became_ready_via: "already_ready",
        previous_status: "absent",
        provider: "codex"
      }
    }
  ]);
});

test("requestStatuses fires agent.env_detected once per detection outcome", async () => {
  const events: ReporterEventInput[] = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ]),
        createStatusResponse([
          createProviderStatus({ actions: [], availability: "ready" })
        ])
      ]
    }),
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(nextEvents) {
        events.push(
          ...legacyAgentEvents(nextEvents).filter(
            (event) => event.name === "agent.env_detected"
          )
        );
      }
    },
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh();
  await flushAsyncWork();

  // Two identical refreshes resolve to the same outcome → one event.
  assert.equal(events.length, 1);
  assert.equal(events[0]?.params?.provider, "codex");
  assert.equal(events[0]?.params?.availability_status, "ready");
});

test("runAction short-polls login status after sign-in and coalesces repeated login attempts", async () => {
  const commands: AgentProviderTerminalCommand[] = [];
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const pollScheduler = createManualPollScheduler();
  const authRequiredStatus = createProviderStatus({
    actions: [
      {
        command: {
          cwd: "/workspace",
          input: "codex login\n"
        },
        id: "login",
        kind: "terminal_command"
      },
      { id: "refresh", kind: "refresh" }
    ],
    availability: "auth_required"
  });
  const service = new DesktopAgentProviderStatusService({
    loginStatusPollScheduler: pollScheduler.scheduler,
    loginStatusPollIntervalMs: 5_000,
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand(command) {
        commands.push(command);
      }
    }
  });

  await service.refresh();
  await service.runAction("codex", "login");
  await service.runAction("codex", "login");
  await waitFor(() => statusCalls.length >= 3);

  assert.equal(pollScheduler.pendingTimerCount(), 1);
  assert.equal(commands.length, 2);

  pollScheduler.runNext();
  await waitFor(
    () => service.getStatus("codex")?.availability.status === "ready"
  );

  assert.equal(service.getStatus("codex")?.availability.status, "ready");
  assert.equal(pollScheduler.pendingTimerCount(), 0);
  assert.deepEqual(statusCalls, [undefined, ["codex"], ["codex"], ["codex"]]);
});

test("runAction stops login status polling after the default three minute window", async () => {
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const pollScheduler = createManualPollScheduler();
  const authRequiredStatus = createProviderStatus({
    actions: [
      {
        command: {
          cwd: "/workspace",
          input: "codex login\n"
        },
        id: "login",
        kind: "terminal_command"
      },
      { id: "refresh", kind: "refresh" }
    ],
    availability: "auth_required"
  });
  const service = new DesktopAgentProviderStatusService({
    loginStatusPollScheduler: pollScheduler.scheduler,
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([authRequiredStatus])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.runAction("codex", "login");
  await waitFor(() => statusCalls.length >= 2);

  pollScheduler.advance(179_999);
  pollScheduler.runNext();
  await waitFor(() => statusCalls.length >= 3);

  assert.equal(pollScheduler.pendingTimerCount(), 1);

  pollScheduler.advance(1);
  pollScheduler.runNext();
  await flushAsyncWork();

  assert.equal(statusCalls.length, 3);
  assert.equal(pollScheduler.pendingTimerCount(), 0);
});

test("runAction installs providers silently and refreshes the status", async () => {
  const commands: AgentProviderTerminalCommand[] = [];
  const actionCalls: Array<
    [WorkspaceAgentProvider, AgentProviderActionRunResponse["actionID"]]
  > = [];
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const pendingSnapshots: boolean[] = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onRunActionRequest: (provider, actionID) =>
        actionCalls.push([provider, actionID]),
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [
              {
                command: {
                  cwd: "/workspace",
                  input: "npm install -g @anthropic-ai/claude-code\n"
                },
                id: "install",
                kind: "terminal_command"
              }
            ],
            availability: "not_installed"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand(command) {
        commands.push(command);
      }
    }
  });
  service.subscribe(() => {
    pendingSnapshots.push(service.isActionPending("codex", "install"));
  });

  await service.refresh();
  await service.runAction("codex", "install", { workspaceId: "workspace-1" });

  assert.deepEqual(commands, []);
  assert.deepEqual(actionCalls, [["codex", "install"]]);
  assert.deepEqual(statusCalls, [undefined, ["codex"]]);
  assert.equal(service.isActionPending("codex", "install"), false);
  assert.equal(pendingSnapshots.includes(true), true);
});

test("runAction short-polls install status while daemon action is pending", async () => {
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const pollScheduler = createManualPollScheduler();
  const installRun = createDeferred<AgentProviderActionRunResponse>();
  const installingStatus = createProviderStatus({
    actions: [{ id: "install", kind: "daemon_action" }],
    availability: "not_installed",
    provider: "claude-code"
  });
  const service = new DesktopAgentProviderStatusService({
    loginStatusPollScheduler: pollScheduler.scheduler,
    tuttidClient: {
      async getAgentProviderStatuses(request) {
        statusCalls.push(request?.providers);
        return createStatusResponse([installingStatus]);
      },
      async runAgentProviderAction(provider, actionID) {
        assert.equal(provider, "claude-code");
        assert.equal(actionID, "install");
        return installRun.promise;
      }
    } as Partial<TuttidClient> as TuttidClient,
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh(["claude-code"]);
  const runPromise = service.runAction("claude-code", "install");
  await waitFor(() => pollScheduler.pendingTimerCount() === 1);

  pollScheduler.runNext();
  await waitFor(() => statusCalls.length >= 2);

  assert.deepEqual(statusCalls, [["claude-code"], ["claude-code"]]);

  installRun.resolve(
    createActionRunResponse("claude-code", "install", "completed")
  );
  await runPromise;

  assert.equal(pollScheduler.pendingTimerCount(), 0);
  assert.equal(service.isActionPending("claude-code", "install"), false);
});

test("runAction reports daemon install action failures and skips refresh", async () => {
  const notifications = createNotificationRecorder();
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const service = new DesktopAgentProviderStatusService(
    {
      tuttidClient: createTuttidClient({
        onStatusRequest: (providers) => statusCalls.push(providers),
        actionRuns: [
          {
            actionID: "install",
            completedAt: "2026-06-02T08:00:00.000Z",
            message: "adapter boom",
            provider: "codex",
            reasonCode: "post_install_probe_failed",
            status: "failed"
          }
        ],
        snapshots: [
          createStatusResponse([
            createProviderStatus({
              actions: [
                {
                  command: {
                    cwd: "/workspace",
                    input: "npm install -g @openai/codex\n"
                  },
                  id: "install",
                  kind: "terminal_command"
                }
              ],
              availability: "not_installed"
            })
          ])
        ]
      }),
      terminalCommandRunner: {
        async runTerminalCommand() {}
      }
    },
    notifications.service
  );

  await service.refresh();
  await assert.rejects(() => service.runAction("codex", "install"));

  assert.deepEqual(statusCalls, [undefined]);
  assert.deepEqual(notifications.items, [
    {
      description: "adapter boom",
      tone: "error",
      title: "Connection failed"
    }
  ]);
});

test("runAction summarizes technical install probe failures for toast copy", async () => {
  const notifications = createNotificationRecorder();
  const service = new DesktopAgentProviderStatusService(
    {
      tuttidClient: createTuttidClient({
        actionRuns: [
          {
            actionID: "install",
            completedAt: "2026-06-02T08:00:00.000Z",
            message:
              "Error: spawn /Users/example/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/vendor/codex ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)",
            provider: "codex",
            reasonCode: "post_install_probe_failed",
            status: "failed"
          }
        ],
        snapshots: [
          createStatusResponse([
            createProviderStatus({
              actions: [
                {
                  command: {
                    cwd: "/workspace",
                    input: "npm install -g @openai/codex\n"
                  },
                  id: "install",
                  kind: "terminal_command"
                }
              ],
              availability: "not_installed"
            })
          ])
        ]
      }),
      terminalCommandRunner: {
        async runTerminalCommand() {}
      }
    },
    notifications.service
  );

  await service.refresh();
  await assert.rejects(() => service.runAction("codex", "install"));

  assert.deepEqual(notifications.items, [
    {
      description:
        "The local agent executable could not be found. Check that it is installed correctly.",
      tone: "error",
      title: "Connection failed"
    }
  ]);
});

test("runAction reports install failures and clears pending state", async () => {
  const notifications = createNotificationRecorder();
  const service = new DesktopAgentProviderStatusService(
    {
      tuttidClient: createTuttidClient({
        actionRuns: [
          {
            actionID: "install",
            completedAt: "2026-06-02T08:00:00.000Z",
            message: "network unavailable",
            provider: "codex",
            reasonCode: "install_command_failed",
            status: "failed"
          }
        ],
        snapshots: [
          createStatusResponse([
            createProviderStatus({
              actions: [
                {
                  command: {
                    cwd: "/workspace",
                    input: "npm install -g missing-agent\n"
                  },
                  id: "install",
                  kind: "terminal_command"
                }
              ],
              availability: "not_installed"
            })
          ])
        ]
      }),
      terminalCommandRunner: {
        async runTerminalCommand() {}
      }
    },
    notifications.service
  );

  await service.refresh();
  await assert.rejects(() => service.runAction("codex", "install"));

  assert.equal(service.isActionPending("codex", "install"), false);
  assert.deepEqual(notifications.items, [
    {
      description: "network unavailable",
      tone: "error",
      title: "Connection failed"
    }
  ]);
});

test("runAction summarizes Claude regional availability install failures", async () => {
  const notifications = createNotificationRecorder();
  const service = new DesktopAgentProviderStatusService(
    {
      tuttidClient: createTuttidClient({
        actionRuns: [
          {
            actionID: "install",
            completedAt: "2026-06-02T08:00:00.000Z",
            message:
              '<!DOCTYPE html><html><head><title>App unavailable in region | Claude</title><meta content="Unfortunately, Claude isn&#x27;t available here." name="description"></head></html>',
            provider: "claude-code",
            reasonCode: "install_command_failed",
            status: "failed"
          }
        ],
        snapshots: [
          createStatusResponse([
            createProviderStatus({
              actions: [
                {
                  command: {
                    cwd: "/workspace",
                    input: "npm install -g @anthropic-ai/claude-code\n"
                  },
                  id: "install",
                  kind: "terminal_command"
                }
              ],
              availability: "not_installed",
              provider: "claude-code"
            })
          ])
        ]
      }),
      terminalCommandRunner: {
        async runTerminalCommand() {}
      }
    },
    notifications.service
  );

  await service.refresh();
  await assert.rejects(() => service.runAction("claude-code", "install"));

  assert.deepEqual(notifications.items, [
    {
      description: "Claude isn't available in this region.",
      tone: "error",
      title: "Connection failed"
    }
  ]);
});

test("runAction reports login launch failures and clears pending state", async () => {
  const events: ReporterEventInput[] = [];
  const notifications = createNotificationRecorder();
  const service = new DesktopAgentProviderStatusService(
    {
      tuttidClient: createTuttidClient({
        snapshots: [
          createStatusResponse([
            createProviderStatus({
              actions: [
                {
                  command: {
                    cwd: "/workspace",
                    input: "codex login\n"
                  },
                  id: "login",
                  kind: "terminal_command"
                }
              ],
              availability: "auth_required"
            })
          ])
        ]
      }),
      reporterNow: () => 1749124800000,
      reporterService: {
        async trackEvents(nextEvents) {
          events.push(
            ...legacyAgentEvents(nextEvents).filter(
              (event) => event.name !== "agent.env_detected"
            )
          );
        }
      },
      terminalCommandRunner: {
        async runTerminalCommand() {
          throw new Error("missing workbench host");
        }
      }
    },
    notifications.service
  );

  await service.refresh();
  await assert.rejects(() => service.runAction("codex", "login"));

  assert.equal(service.isActionPending("codex", "login"), false);
  assert.deepEqual(events, [
    {
      clientTS: 1749124800000,
      name: "agent.provider_login_initiated",
      params: {
        provider: "codex"
      }
    },
    {
      clientTS: 1749124800000,
      name: "agent.provider_login_result",
      params: {
        error_reason: "launch_failed",
        provider: "codex",
        success: false
      }
    }
  ]);
  assert.deepEqual(notifications.items, [
    {
      description: "An unexpected service error occurred. Please try again.",
      tone: "error",
      title: "Sign-in failed"
    }
  ]);
});

test("runAction refreshes when the action is a refresh action", async () => {
  const commands: AgentProviderTerminalCommand[] = [];
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [{ id: "refresh", kind: "refresh" }],
            availability: "unknown"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand(command) {
        commands.push(command);
      }
    }
  });

  await service.refresh();
  await service.runAction("codex", "refresh");

  assert.deepEqual(commands, []);
  assert.deepEqual(statusCalls, [undefined, ["codex"]]);
});

test("provider-scoped refresh merges the returned status into the existing snapshot", async () => {
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [{ id: "login", kind: "terminal_command" }],
            availability: "auth_required",
            provider: "codex"
          }),
          createProviderStatus({
            actions: [{ id: "login", kind: "terminal_command" }],
            availability: "auth_required",
            provider: "claude-code"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready",
            provider: "codex"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh(["codex"]);

  assert.equal(service.getStatus("codex")?.availability.status, "ready");
  assert.equal(
    service.getStatus("claude-code")?.availability.status,
    "auth_required"
  );
  assert.deepEqual(statusCalls, [undefined, ["codex"]]);
});

test("ensureLoaded reuses loaded provider statuses and only loads missing providers", async () => {
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready",
            provider: "codex"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready",
            provider: "claude-code"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh(["codex"]);
  await service.ensureLoaded({ providers: ["codex"] });
  await service.ensureLoaded({ providers: ["claude-code"] });

  assert.deepEqual(statusCalls, [["codex"], ["claude-code"]]);
});

test("ensureLoaded waits for unrelated in-flight loads before loading missing providers", async () => {
  const calls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const firstStatusRequest = createDeferred<AgentProviderStatusListResponse>();
  const secondStatusRequest = createDeferred<AgentProviderStatusListResponse>();
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: {
      async getAgentProviderStatuses(request) {
        calls.push(request?.providers);
        return calls.length === 1
          ? firstStatusRequest.promise
          : secondStatusRequest.promise;
      }
    } as Partial<TuttidClient> as TuttidClient,
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  const codexLoad = service.refresh(["codex"]);
  const claudeEnsure = service.ensureLoaded({ providers: ["claude-code"] });

  assert.deepEqual(calls, [["codex"]]);

  firstStatusRequest.resolve(
    createStatusResponse([
      createProviderStatus({
        actions: [],
        availability: "ready",
        provider: "codex"
      })
    ])
  );
  await codexLoad;

  assert.deepEqual(calls, [["codex"], ["claude-code"]]);

  secondStatusRequest.resolve(
    createStatusResponse([
      createProviderStatus({
        actions: [],
        availability: "ready",
        provider: "claude-code"
      })
    ])
  );
  await claudeEnsure;

  assert.equal(service.getStatus("codex")?.availability.status, "ready");
  assert.equal(service.getStatus("claude-code")?.availability.status, "ready");
});

test("refresh waits for an in-flight load and then requests a fresh status", async () => {
  const calls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const firstStatusRequest = createDeferred<AgentProviderStatusListResponse>();
  const secondStatusRequest = createDeferred<AgentProviderStatusListResponse>();
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: {
      async getAgentProviderStatuses(request) {
        calls.push(request?.providers);
        return calls.length === 1
          ? firstStatusRequest.promise
          : secondStatusRequest.promise;
      }
    } as Partial<TuttidClient> as TuttidClient,
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  const initialLoad = service.ensureLoaded({ providers: ["codex"] });
  const explicitRefresh = service.refresh(["codex"]);

  assert.deepEqual(calls, [["codex"]]);

  firstStatusRequest.resolve(
    createStatusResponse([
      createProviderStatus({
        actions: [],
        availability: "auth_required",
        provider: "codex"
      })
    ])
  );
  await initialLoad;
  await Promise.resolve();

  assert.deepEqual(calls, [["codex"], ["codex"]]);

  secondStatusRequest.resolve(
    createStatusResponse([
      createProviderStatus({
        actions: [],
        availability: "ready",
        provider: "codex"
      })
    ])
  );
  await explicitRefresh;

  assert.equal(service.getStatus("codex")?.availability.status, "ready");
});

test("provider-scoped refresh immediately replaces ready status when CLI is missing", async () => {
  const missingCodexStatus = createProviderStatus({
    actions: [{ id: "install", kind: "daemon_action" }],
    availability: "not_installed",
    cliInstalled: false,
    provider: "codex",
    reasonCode: "cli_not_found"
  });
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready",
            provider: "codex"
          })
        ]),
        createStatusResponse([missingCodexStatus]),
        createStatusResponse([missingCodexStatus])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh(["codex"]);

  assert.equal(
    service.getStatus("codex")?.availability.status,
    "not_installed"
  );
});

test("provider-scoped refresh immediately replaces ready status when ACP adapter is missing", async () => {
  const missingClaudeAdapterStatus = createProviderStatus({
    actions: [{ id: "install", kind: "daemon_action" }],
    adapterInstalled: false,
    availability: "not_installed",
    cliInstalled: true,
    provider: "claude-code",
    reasonCode: "acp_adapter_not_found"
  });
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "ready",
            provider: "claude-code"
          })
        ]),
        createStatusResponse([missingClaudeAdapterStatus])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh(["claude-code"]);

  assert.equal(
    service.getStatus("claude-code")?.availability.status,
    "not_installed"
  );
  assert.equal(service.getStatus("claude-code")?.adapter.installed, false);
});

test("provider-scoped refresh confirms auth downgrades before replacing a ready status", async () => {
  const authRequiredStatus = createProviderStatus({
    actions: [
      {
        command: {
          cwd: "/workspace",
          input: "claude auth login\n"
        },
        id: "login",
        kind: "terminal_command"
      }
    ],
    availability: "auth_required",
    provider: "claude-code",
    reasonCode: "auth_required"
  });
  const readyStatus = createProviderStatus({
    actions: [],
    availability: "ready",
    provider: "claude-code"
  });
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([readyStatus]),
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([readyStatus]),
        createStatusResponse([authRequiredStatus]),
        createStatusResponse([authRequiredStatus])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh(["claude-code"]);

  assert.equal(service.getStatus("claude-code")?.availability.status, "ready");

  await service.refresh(["claude-code"]);

  assert.equal(service.getStatus("claude-code")?.availability.status, "ready");

  await service.refresh(["claude-code"]);

  assert.equal(service.getStatus("claude-code")?.availability.status, "ready");

  await service.refresh(["claude-code"]);

  assert.equal(
    service.getStatus("claude-code")?.availability.status,
    "auth_required"
  );
});

test("provider-scoped refresh confirms auth-unknown downgrades before replacing a ready status", async () => {
  const authUnknownStatus = createProviderStatus({
    actions: [
      {
        command: {
          cwd: "/workspace",
          input: "claude auth login\n"
        },
        id: "login",
        kind: "terminal_command"
      },
      { id: "refresh", kind: "refresh" }
    ],
    availability: "auth_required",
    provider: "claude-code",
    reasonCode: "auth_unknown"
  });
  const readyStatus = createProviderStatus({
    actions: [],
    availability: "ready",
    provider: "claude-code"
  });
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      snapshots: [
        createStatusResponse([readyStatus]),
        createStatusResponse([authUnknownStatus]),
        createStatusResponse([authUnknownStatus])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();
  await service.refresh(["claude-code"]);

  assert.equal(service.getStatus("claude-code")?.availability.status, "ready");

  await service.refresh(["claude-code"]);

  assert.equal(
    service.getStatus("claude-code")?.availability.status,
    "auth_required"
  );
});

test("runAction refreshes and executes when the requested action appears", async () => {
  const commands: AgentProviderTerminalCommand[] = [];
  const statusCalls: Array<readonly WorkspaceAgentProvider[] | undefined> = [];
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: createTuttidClient({
      onStatusRequest: (providers) => statusCalls.push(providers),
      snapshots: [
        createStatusResponse([
          createProviderStatus({
            actions: [],
            availability: "auth_required"
          })
        ]),
        createStatusResponse([
          createProviderStatus({
            actions: [
              {
                command: {
                  cwd: "/workspace",
                  input: "codex login\n"
                },
                id: "login",
                kind: "terminal_command"
              }
            ],
            availability: "auth_required"
          })
        ])
      ]
    }),
    terminalCommandRunner: {
      async runTerminalCommand(command) {
        commands.push(command);
      }
    }
  });

  await service.refresh();
  await service.runAction("codex", "login");

  assert.deepEqual(commands, [
    {
      cwd: "/workspace",
      input: "codex login\n"
    }
  ]);
  assert.deepEqual(statusCalls, [undefined, ["codex"], ["codex"]]);
});

test("runAction reports missing login actions after refresh", async () => {
  const commands: AgentProviderTerminalCommand[] = [];
  const notifications = createNotificationRecorder();
  const service = new DesktopAgentProviderStatusService(
    {
      tuttidClient: createTuttidClient({
        snapshots: [
          createStatusResponse([
            createProviderStatus({
              actions: [],
              availability: "unknown"
            })
          ]),
          createStatusResponse([
            createProviderStatus({
              actions: [],
              availability: "unknown"
            })
          ])
        ]
      }),
      terminalCommandRunner: {
        async runTerminalCommand(command) {
          commands.push(command);
        }
      }
    },
    notifications.service
  );

  await service.refresh();
  await service.runAction("codex", "login");

  assert.deepEqual(commands, []);
  assert.deepEqual(notifications.items, [
    {
      description: undefined,
      tone: "error",
      title: "Sign-in failed"
    }
  ]);
});

test("refresh times out and releases the loading state when the status request hangs", async () => {
  const service = new DesktopAgentProviderStatusService({
    tuttidClient: {
      getAgentProviderStatuses: async () =>
        new Promise<AgentProviderStatusListResponse>(() => {})
    } as Partial<TuttidClient> as TuttidClient,
    requestTimeoutMs: 1,
    terminalCommandRunner: {
      async runTerminalCommand() {}
    }
  });

  await service.refresh();

  assert.equal(service.getSnapshot().isLoading, false);
  assert.notEqual(service.getSnapshot().error, null);
});

function createTuttidClient(input: {
  actionRuns?: AgentProviderActionRunResponse[];
  onProbeRequest?: (provider: WorkspaceAgentProvider) => void;
  onRunActionRequest?: (
    provider: WorkspaceAgentProvider,
    actionID: AgentProviderActionRunResponse["actionID"]
  ) => void;
  onStatusRequest?: (
    providers: readonly WorkspaceAgentProvider[] | undefined,
    includeNetwork?: boolean
  ) => void;
  probes?: AgentProviderProbeResponse[];
  snapshots: AgentProviderStatusListResponse[];
}): TuttidClient {
  let index = 0;
  let actionRunIndex = 0;
  let probeIndex = 0;
  return {
    async getAgentProviderStatuses(request) {
      input.onStatusRequest?.(request?.providers, request?.includeNetwork);
      const snapshot = input.snapshots[index] ?? input.snapshots.at(-1);
      index += 1;
      if (!snapshot) {
        throw new Error("missing snapshot");
      }
      return snapshot;
    },
    async probeAgentProvider(provider) {
      input.onProbeRequest?.(provider);
      const probe =
        input.probes?.[probeIndex] ??
        input.probes?.at(-1) ??
        createProbeResponse(provider, "ready");
      probeIndex += 1;
      return probe;
    },
    async runAgentProviderAction(provider, actionID) {
      input.onRunActionRequest?.(provider, actionID);
      const actionRun =
        input.actionRuns?.[actionRunIndex] ??
        input.actionRuns?.at(-1) ??
        createActionRunResponse(provider, actionID, "completed");
      actionRunIndex += 1;
      return actionRun;
    }
  } as Partial<TuttidClient> as TuttidClient;
}

function createStatusResponse(
  providers: AgentProviderStatus[]
): AgentProviderStatusListResponse {
  return {
    capturedAt: "2026-06-02T08:00:00.000Z",
    defaultProvider: "codex",
    providers
  };
}

function createProbeResponse(
  provider: WorkspaceAgentProvider,
  status: AgentProviderProbeResponse["status"]
): AgentProviderProbeResponse {
  return {
    checkedAt: "2026-06-02T08:00:00.000Z",
    command: ["codex"],
    provider,
    status
  };
}

function createActionRunResponse(
  provider: WorkspaceAgentProvider,
  actionID: AgentProviderActionRunResponse["actionID"],
  status: AgentProviderActionRunResponse["status"]
): AgentProviderActionRunResponse {
  return {
    actionID,
    completedAt: "2026-06-02T08:00:00.000Z",
    provider,
    status
  };
}

function createNotificationRecorder(): {
  items: Array<{
    description: string | undefined;
    tone: "error" | "info" | "success" | "warning";
    title: string;
  }>;
  service: NotificationService;
} {
  const items: Array<{
    description: string | undefined;
    tone: "error" | "info" | "success" | "warning";
    title: string;
  }> = [];
  return {
    items,
    service: {
      _serviceBrand: undefined,
      error(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "error"
        });
      },
      info(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "info"
        });
      },
      notify(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: input.level
        });
      },
      success(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "success"
        });
      },
      warning(input) {
        items.push({
          description: input.description,
          title: input.title,
          tone: "warning"
        });
      }
    }
  };
}

function createProviderStatus(input: {
  actions: AgentProviderStatus["actions"];
  adapterInstalled?: boolean;
  availability: AgentProviderStatus["availability"]["status"];
  cliInstalled?: boolean;
  network?: AgentProviderStatus["network"];
  provider?: WorkspaceAgentProvider;
  reasonCode?: string;
}): AgentProviderStatus {
  const cliInstalled =
    input.cliInstalled ??
    (input.availability !== "not_installed" &&
      input.availability !== "unsupported");
  return {
    actions: input.actions,
    adapter: {
      command: ["codex"],
      installed:
        input.adapterInstalled ??
        (input.availability !== "not_installed" &&
          input.availability !== "unsupported")
    },
    auth: {
      status: input.availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      reasonCode: input.reasonCode,
      status: input.availability
    },
    cli: {
      installed: cliInstalled
    },
    network: input.network,
    provider: input.provider ?? "codex"
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolveValue?.(value);
    }
  };
}

function createManualPollScheduler() {
  let nowMs = 0;
  let nextTimerId = 0;
  const timers = new Map<number, () => void>();
  return {
    advance(ms: number) {
      nowMs += ms;
    },
    pendingTimerCount() {
      return timers.size;
    },
    runNext() {
      const [timerId, callback] = timers.entries().next().value ?? [];
      if (timerId === undefined || !callback) {
        return false;
      }
      timers.delete(timerId);
      callback();
      return true;
    },
    scheduler: {
      clearTimeout(timer: unknown) {
        timers.delete(timer as number);
      },
      now() {
        return nowMs;
      },
      setTimeout(callback: () => void) {
        nextTimerId += 1;
        timers.set(nextTimerId, callback);
        return nextTimerId;
      }
    }
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
