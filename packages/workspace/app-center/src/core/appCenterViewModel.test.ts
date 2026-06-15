import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceAppRecord } from "../contracts/catalog.ts";
import { workspaceAppManifestSchemaVersion } from "../contracts/manifest.ts";
import { createAppCenterViewModel } from "./appCenterViewModel.ts";

describe("createAppCenterViewModel", () => {
  it("derives sorted app cards and aggregate counts", () => {
    const apps: WorkspaceAppRecord[] = [
      {
        install: { appId: "zeta" },
        manifest: {
          appId: "zeta",
          description: "Zeta app",
          runtime: {
            bootstrap: "bootstrap.sh",
            healthcheckPath: "/"
          },
          schemaVersion: workspaceAppManifestSchemaVersion,
          name: "Zeta",
          version: "0.1.0"
        }
      },
      {
        install: null,
        manifest: {
          appId: "alpha",
          description: "Alpha app",
          runtime: {
            bootstrap: "bootstrap.sh",
            healthcheckPath: "/"
          },
          schemaVersion: workspaceAppManifestSchemaVersion,
          name: "Alpha",
          version: "0.1.0"
        }
      }
    ];

    const viewModel = createAppCenterViewModel({
      apps,
      runtimeStates: [
        {
          appId: "zeta",
          error: {
            message: "Launch failed"
          },
          status: "failed"
        }
      ]
    });

    assert.equal(viewModel.empty, false);
    assert.equal(viewModel.installedCount, 1);
    assert.equal(viewModel.failedCount, 1);
    assert.deepEqual(
      viewModel.apps.map((app) => app.id),
      ["alpha", "zeta"]
    );
    assert.equal(viewModel.apps[0]?.canOpen, false);
    assert.equal(viewModel.apps[0]?.canOpenFolder, false);
    assert.equal(viewModel.apps[0]?.canOpenPackageFolder, false);
    assert.equal(viewModel.apps[0]?.primaryAction, "install");
    assert.equal(viewModel.apps[0]?.statusLabelKey, "actions.installApp");
    assert.equal(viewModel.apps[1]?.primaryAction, "retry");
    assert.equal(viewModel.apps[1]?.canOpenFolder, true);
    assert.equal(viewModel.apps[1]?.canOpenPackageFolder, false);
    assert.equal(viewModel.apps[1]?.errorMessage, "Launch failed");
  });

  it("uses localized catalog metadata when the locale matches", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          catalog: {
            localizations: [
              {
                locale: "zh-CN",
                name: "自动化",
                description: "管理工作区自动化任务。",
                tags: ["自动化", "工作区"]
              }
            ],
            manifest: {
              appId: "automation",
              description: "Schedule workspace automation.",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Automation",
              tags: ["automation", "workspace"],
              version: "0.1.0"
            }
          },
          category: "工具",
          install: { appId: "automation" },
          manifest: {
            appId: "automation",
            description: "Schedule workspace automation.",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Automation",
            tags: ["automation", "workspace"],
            version: "0.1.0"
          }
        }
      ],
      locale: "zh-CN"
    });

    assert.equal(viewModel.apps[0]?.name, "自动化");
    assert.equal(viewModel.apps[0]?.category, "工具");
    assert.equal(viewModel.apps[0]?.description, "管理工作区自动化任务。");
    assert.deepEqual(viewModel.apps[0]?.tags, ["自动化", "工作区"]);
  });

  it("keeps coming soon apps disabled even when localized tags differ", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          catalog: {
            localizations: [
              {
                locale: "zh-CN",
                name: "AI 文档",
                description: "AI 辅助文档创作。",
                tags: ["办公", "敬请期待"]
              }
            ],
            manifest: {
              appId: "ai-document",
              description: "AI document creation.",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "AI Docs",
              tags: ["coming-soon", "office", "document"],
              version: "0.1.0"
            }
          },
          install: null,
          manifest: {
            appId: "ai-document",
            description: "AI document creation.",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "AI Docs",
            tags: ["coming-soon", "office", "document"],
            version: "0.1.0"
          }
        }
      ],
      locale: "zh-CN"
    });

    assert.equal(viewModel.apps[0]?.name, "AI 文档");
    assert.deepEqual(viewModel.apps[0]?.tags, ["办公", "敬请期待"]);
    assert.equal(viewModel.apps[0]?.canOpen, false);
    assert.equal(viewModel.apps[0]?.primaryAction, "none");
    assert.equal(viewModel.apps[0]?.statusLabelKey, "status.comingSoon");
    assert.equal(viewModel.apps[0]?.version, undefined);
  });

  it("opens installed apps from the card even before they are running", () => {
    const apps: WorkspaceAppRecord[] = [
      {
        install: { appId: "hello" },
        manifest: {
          appId: "hello",
          description: "Hello app",
          runtime: {
            bootstrap: "bootstrap.sh",
            healthcheckPath: "/"
          },
          schemaVersion: workspaceAppManifestSchemaVersion,
          name: "Hello",
          version: "0.1.0"
        }
      }
    ];

    const idleViewModel = createAppCenterViewModel({
      apps,
      runtimeStates: [
        {
          appId: "hello",
          status: "idle"
        }
      ]
    });
    assert.equal(idleViewModel.apps[0]?.canOpen, true);
    assert.equal(idleViewModel.apps[0]?.primaryAction, "open");
    assert.equal(idleViewModel.apps[0]?.statusLabelKey, "actions.openApp");

    const runningViewModel = createAppCenterViewModel({
      apps,
      runtimeStates: [
        {
          appId: "hello",
          status: "running"
        }
      ]
    });
    assert.equal(runningViewModel.apps[0]?.canOpen, true);
    assert.equal(runningViewModel.apps[0]?.primaryAction, "open");
    assert.equal(runningViewModel.apps[0]?.statusLabelKey, "actions.openApp");
  });

  it("matches runtime state by installation id before app id fallback", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          install: {
            appId: "remote",
            installationId: "inst-1",
            version: "0.2.0"
          },
          manifest: {
            appId: "remote",
            description: "Remote app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Remote",
            version: "0.1.0"
          }
        },
        {
          install: { appId: "legacy" },
          manifest: {
            appId: "legacy",
            description: "Legacy app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Legacy",
            version: "1.0.0"
          }
        }
      ],
      runtimeStates: [
        {
          appId: "remote",
          launchUrl: "http://127.0.0.1:1111",
          status: "failed"
        },
        {
          appId: "remote",
          installationId: "inst-1",
          launchUrl: "https://remote.example/app",
          runtimeId: "rt-1",
          status: "running"
        },
        {
          appId: "legacy",
          launchUrl: "http://127.0.0.1:2222",
          status: "running"
        }
      ]
    });

    const legacyApp = viewModel.apps.find((app) => app.id === "legacy");
    const remoteApp = viewModel.apps.find((app) => app.id === "remote");
    assert.equal(remoteApp?.status, "running");
    assert.equal(remoteApp?.installationId, "inst-1");
    assert.equal(remoteApp?.runtimeId, "rt-1");
    assert.equal(remoteApp?.launchUrl, "https://remote.example/app");
    assert.equal(remoteApp?.version, "0.2.0");
    assert.equal(legacyApp?.status, "running");
    assert.equal(legacyApp?.launchUrl, "http://127.0.0.1:2222");
  });

  it("does not use app id fallback runtime states from another installation", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          install: {
            appId: "remote",
            installationId: "inst-1"
          },
          manifest: {
            appId: "remote",
            description: "Remote app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Remote",
            version: "0.1.0"
          }
        }
      ],
      runtimeStates: [
        {
          appId: "remote",
          installationId: "inst-2",
          status: "failed"
        }
      ]
    });

    assert.equal(viewModel.apps[0]?.status, "idle");
    assert.equal(viewModel.apps[0]?.runtimeId, null);
    assert.equal(viewModel.apps[0]?.launchUrl, null);
  });

  it("uses update as the primary action for installed apps with updates", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          availableVersion: "0.2.0",
          install: { appId: "hello" },
          manifest: {
            appId: "hello",
            description: "Hello app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Hello",
            version: "0.1.0"
          },
          updateAvailable: true
        }
      ],
      runtimeStates: [
        {
          appId: "hello",
          status: "running"
        }
      ]
    });

    assert.equal(viewModel.apps[0]?.canOpen, true);
    assert.equal(viewModel.apps[0]?.canUpdate, true);
    assert.equal(viewModel.apps[0]?.primaryAction, "update");
    assert.equal(viewModel.apps[0]?.statusLabelKey, "actions.updateApp");
  });

  it("keeps unavailable apps inert", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          availableVersion: "0.2.0",
          install: { appId: "remote" },
          manifest: {
            appId: "remote",
            description: "Remote app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Remote",
            version: "0.1.0"
          },
          updateAvailable: true
        }
      ],
      runtimeStates: [
        {
          appId: "remote",
          status: "unavailable"
        }
      ]
    });

    assert.equal(viewModel.apps[0]?.canOpen, false);
    assert.equal(viewModel.apps[0]?.canRetry, false);
    assert.equal(viewModel.apps[0]?.canUpdate, false);
    assert.equal(viewModel.apps[0]?.primaryAction, "none");
    assert.equal(viewModel.apps[0]?.statusLabelKey, "status.unavailable");
    assert.equal(viewModel.apps[0]?.statusTone, "amber");
    assert.equal(viewModel.apps[0]?.statusPulse, false);
  });

  it("disables update actions while an app is busy", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          availableVersion: "0.2.0",
          install: { appId: "hello" },
          manifest: {
            appId: "hello",
            description: "Hello app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Hello",
            version: "0.1.0"
          },
          updateAvailable: true
        }
      ],
      runtimeStates: [
        {
          appId: "hello",
          status: "installing"
        }
      ]
    });

    assert.equal(viewModel.apps[0]?.canUpdate, false);
    assert.equal(viewModel.apps[0]?.primaryAction, "none");
    assert.equal(viewModel.apps[0]?.statusLabelKey, "status.installing");
  });

  it("shows installing apps as busy before they become installed", () => {
    const apps: WorkspaceAppRecord[] = [
      {
        install: null,
        manifest: {
          appId: "remote",
          description: "Remote app",
          runtime: {
            bootstrap: "bootstrap.sh",
            healthcheckPath: "/"
          },
          schemaVersion: workspaceAppManifestSchemaVersion,
          name: "Remote",
          version: "0.1.0"
        }
      }
    ];

    const viewModel = createAppCenterViewModel({
      apps,
      runtimeStates: [
        {
          appId: "remote",
          status: "installing"
        }
      ]
    });

    assert.equal(viewModel.apps[0]?.installed, false);
    assert.equal(viewModel.apps[0]?.status, "installing");
    assert.equal(viewModel.apps[0]?.statusLabelKey, "status.installing");
    assert.equal(viewModel.apps[0]?.primaryAction, "none");
  });

  it("keeps catalog source kind for recommended and user-owned grouping", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          catalog: {
            manifest: {
              appId: "builtin",
              description: "Builtin app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Builtin Tool",
              version: "0.1.0"
            },
            source: {
              kind: "bundled"
            }
          },
          install: { appId: "builtin" },
          manifest: {
            appId: "builtin",
            description: "Builtin app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Builtin Tool",
            version: "0.1.0"
          }
        },
        {
          catalog: {
            manifest: {
              appId: "local",
              description: "Imported app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Imported Tool",
              version: "0.1.0"
            },
            source: {
              kind: "local"
            }
          },
          install: null,
          manifest: {
            appId: "local",
            description: "Imported app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Imported Tool",
            version: "0.1.0"
          }
        }
      ]
    });

    const builtinApp = viewModel.apps.find((app) => app.id === "builtin");
    const localApp = viewModel.apps.find((app) => app.id === "local");
    assert.equal(builtinApp?.installed, true);
    assert.equal(builtinApp?.sourceKind, "bundled");
    assert.equal(localApp?.installed, false);
    assert.equal(localApp?.sourceKind, "local");
  });

  it("exposes uninstall and delete actions by source kind and installation state", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          catalog: {
            manifest: {
              appId: "builtin",
              description: "Builtin app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Builtin Tool",
              version: "0.1.0"
            },
            source: {
              kind: "bundled"
            }
          },
          install: { appId: "builtin" },
          manifest: {
            appId: "builtin",
            description: "Builtin app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Builtin Tool",
            version: "0.1.0"
          }
        },
        {
          catalog: {
            manifest: {
              appId: "local-installed",
              description: "Imported app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Imported Tool",
              version: "0.1.0"
            },
            source: {
              kind: "local"
            }
          },
          install: { appId: "local-installed" },
          manifest: {
            appId: "local-installed",
            description: "Imported app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Imported Tool",
            version: "0.1.0"
          }
        },
        {
          catalog: {
            manifest: {
              appId: "local-uninstalled",
              description: "Imported app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Imported Tool",
              version: "0.1.0"
            },
            source: {
              kind: "local"
            }
          },
          install: null,
          manifest: {
            appId: "local-uninstalled",
            description: "Imported app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Imported Tool",
            version: "0.1.0"
          }
        }
      ]
    });

    const builtinApp = viewModel.apps.find((app) => app.id === "builtin");
    const localInstalledApp = viewModel.apps.find(
      (app) => app.id === "local-installed"
    );
    const localUninstalledApp = viewModel.apps.find(
      (app) => app.id === "local-uninstalled"
    );
    assert.equal(builtinApp?.canUninstall, true);
    assert.equal(builtinApp?.canDelete, false);
    assert.equal(localInstalledApp?.canUninstall, true);
    assert.equal(localInstalledApp?.canDelete, true);
    assert.equal(localUninstalledApp?.canUninstall, false);
    assert.equal(localUninstalledApp?.canDelete, true);
  });

  it("requires an installed version before exposing the app package folder", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          catalog: {
            manifest: {
              appId: "versioned",
              description: "Versioned app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Versioned",
              version: "0.1.0"
            },
            source: {
              kind: "local"
            }
          },
          install: { appId: "versioned" },
          manifest: {
            appId: "versioned",
            description: "Versioned app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Versioned",
            version: "0.1.0"
          }
        },
        {
          catalog: {
            manifest: {
              appId: "unversioned",
              description: "Unversioned app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Unversioned",
              version: " "
            },
            source: {
              kind: "local"
            }
          },
          install: { appId: "unversioned" },
          manifest: {
            appId: "unversioned",
            description: "Unversioned app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Unversioned",
            version: " "
          }
        },
        {
          catalog: {
            manifest: {
              appId: "recommended",
              description: "Recommended app",
              runtime: {
                bootstrap: "bootstrap.sh",
                healthcheckPath: "/"
              },
              schemaVersion: workspaceAppManifestSchemaVersion,
              name: "Recommended",
              version: "0.1.0"
            },
            source: {
              kind: "bundled"
            }
          },
          install: { appId: "recommended" },
          manifest: {
            appId: "recommended",
            description: "Recommended app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Recommended",
            version: "0.1.0"
          }
        }
      ]
    });

    const versionedApp = viewModel.apps.find((app) => app.id === "versioned");
    const unversionedApp = viewModel.apps.find(
      (app) => app.id === "unversioned"
    );
    const recommendedApp = viewModel.apps.find(
      (app) => app.id === "recommended"
    );
    assert.equal(versionedApp?.canOpenPackageFolder, true);
    assert.equal(unversionedApp?.canOpenFolder, true);
    assert.equal(unversionedApp?.canOpenPackageFolder, false);
    assert.equal(recommendedApp?.canOpenFolder, true);
    assert.equal(recommendedApp?.canOpenPackageFolder, false);
  });

  it("exposes factory job agent sessions when available", () => {
    const viewModel = createAppCenterViewModel({
      apps: [],
      factoryJobs: [
        {
          agentSessionId: " agent-session-1 ",
          appId: "app_1",
          displayName: "Generated Tool",
          failureReason: null,
          jobId: "job-1",
          prompt: "Build a tool",
          provider: "codex",
          status: "generating",
          updatedAtUnixMs: 10
        },
        {
          agentSessionId: "",
          appId: "app_2",
          displayName: "Queued Tool",
          failureReason: null,
          jobId: "job-2",
          prompt: "Build another tool",
          provider: "codex",
          status: "queued",
          updatedAtUnixMs: 9
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.[0]?.agentSessionId, "agent-session-1");
    assert.equal(viewModel.factoryJobs?.[0]?.provider, "codex");
    assert.equal(viewModel.factoryJobs?.[0]?.canOpenAgentSession, true);
    assert.equal(viewModel.factoryJobs?.[0]?.canRetryValidation, false);
    assert.equal(viewModel.factoryJobs?.[1]?.canOpenAgentSession, false);
    assert.equal(viewModel.factoryJobs?.[1]?.canRetryValidation, false);
  });

  it("does not use the prompt as a draft factory job title fallback", () => {
    const viewModel = createAppCenterViewModel({
      apps: [],
      factoryJobs: [
        {
          agentSessionId: null,
          appId: "app_123",
          displayName: " ",
          failureReason: null,
          jobId: "job-1",
          prompt: "Build a lightweight todo tracker",
          provider: "codex",
          status: "generating",
          updatedAtUnixMs: 10
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.[0]?.title, "");
  });

  it("binds published factory jobs to app cards instead of the factory job list", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          install: { appId: "app_1" },
          manifest: {
            appId: "app_1",
            description: "Generated app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Generated Tool",
            version: "0.1.0"
          }
        }
      ],
      factoryJobs: [
        {
          agentSessionId: "agent-session-1",
          appId: "app_1",
          displayName: "Generated Tool",
          failureReason: null,
          jobId: "job-1",
          prompt: "Build a tool",
          provider: "codex",
          publishedVersion: "0.1.0",
          status: "published",
          updatedAtUnixMs: 10
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.length, 0);
    assert.equal(viewModel.apps[0]?.factoryJobId, "job-1");
    assert.equal(viewModel.apps[0]?.factoryAgentSessionId, "agent-session-1");
    assert.equal(viewModel.apps[0]?.factoryProvider, "codex");
    assert.equal(viewModel.apps[0]?.factoryEditAction, "prepare_modification");
    assert.equal(viewModel.apps[0]?.canOpenFactorySession, true);
    assert.equal(viewModel.apps[0]?.canPublishFactoryUpdate, false);
  });

  it("exposes republish on app cards when a published factory job becomes ready again", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          install: { appId: "app_1" },
          manifest: {
            appId: "app_1",
            description: "Generated app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Generated Tool",
            version: "0.1.0"
          }
        }
      ],
      factoryJobs: [
        {
          agentSessionId: "agent-session-1",
          appId: "app_1",
          displayName: "Generated Tool",
          failureReason: null,
          jobId: "job-1",
          prompt: "Build a tool",
          provider: "codex",
          publishedVersion: "0.1.0",
          status: "ready",
          updatedAtUnixMs: 11
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.length, 0);
    assert.equal(viewModel.apps[0]?.canOpenFactorySession, true);
    assert.equal(viewModel.apps[0]?.canPublishFactoryUpdate, true);
    assert.equal(viewModel.apps[0]?.factoryEditAction, "open_session");
  });

  it("opens existing agent sessions for failed republish factory jobs", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          install: { appId: "app_1" },
          manifest: {
            appId: "app_1",
            description: "Generated app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Generated Tool",
            version: "0.1.0"
          }
        }
      ],
      factoryJobs: [
        {
          agentSessionId: "agent-session-1",
          appId: "app_1",
          displayName: "Generated Tool",
          failureReason: 'app manifest version must be "0.1.0"',
          jobId: "job-1",
          prompt: "Build a tool",
          provider: "codex",
          publishedVersion: "0.1.0",
          status: "failed",
          updatedAtUnixMs: 11,
          validationResult: {}
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.length, 0);
    assert.equal(viewModel.apps[0]?.factoryJobId, "job-1");
    assert.equal(viewModel.apps[0]?.canOpenFactorySession, true);
    assert.equal(viewModel.apps[0]?.canPublishFactoryUpdate, false);
    assert.equal(viewModel.apps[0]?.factoryEditAction, "open_session");
  });

  it("exposes icon replacement only for replaceable app ids", () => {
    const viewModel = createAppCenterViewModel({
      apps: [
        {
          install: { appId: "app_1" },
          manifest: {
            appId: "app_1",
            description: "Generated app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Generated Tool",
            version: "0.1.0"
          }
        },
        {
          install: { appId: "builtin" },
          manifest: {
            appId: "builtin",
            description: "Builtin app",
            runtime: {
              bootstrap: "bootstrap.sh",
              healthcheckPath: "/"
            },
            schemaVersion: workspaceAppManifestSchemaVersion,
            name: "Builtin Tool",
            version: "0.1.0"
          }
        }
      ],
      replaceableIconAppIds: ["app_1"]
    });

    const replaceableApp = viewModel.apps.find((app) => app.id === "app_1");
    const builtinApp = viewModel.apps.find((app) => app.id === "builtin");
    assert.equal(replaceableApp?.canReplaceIcon, true);
    assert.equal(builtinApp?.canReplaceIcon, false);
  });

  it("exposes factory fix after validation failure without a manual validation action", () => {
    const viewModel = createAppCenterViewModel({
      apps: [],
      factoryJobs: [
        {
          agentSessionId: "agent-session-1",
          appId: "app_1",
          displayName: "Failed Tool",
          failureReason: "Validation failed",
          jobId: "job-1",
          prompt: "Build a tool",
          provider: "codex",
          status: "failed",
          updatedAtUnixMs: 10,
          validationResult: { errors: ["Validation failed"] }
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.[0]?.canRetryValidation, false);
    assert.equal(viewModel.factoryJobs?.[0]?.canFix, true);
    assert.equal(viewModel.factoryJobs?.[0]?.canCancel, false);
    assert.equal(viewModel.factoryJobs?.[0]?.canDelete, true);
  });

  it("does not expose validation actions after non-validation factory failure", () => {
    const viewModel = createAppCenterViewModel({
      apps: [],
      factoryJobs: [
        {
          agentSessionId: "agent-session-1",
          appId: "app_1",
          displayName: "Interrupted Tool",
          failureReason: "App Factory job was interrupted.",
          jobId: "job-1",
          prompt: "Build a tool",
          provider: "codex",
          status: "failed",
          updatedAtUnixMs: 10,
          validationResult: null
        }
      ]
    });

    assert.equal(viewModel.factoryJobs?.[0]?.canRetryValidation, false);
    assert.equal(viewModel.factoryJobs?.[0]?.canFix, false);
    assert.equal(viewModel.factoryJobs?.[0]?.canDelete, true);
  });
});
