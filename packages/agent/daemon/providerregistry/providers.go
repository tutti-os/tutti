package providerregistry

import canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"

// This file owns the descriptors shared by the remaining provider families.

const (
	CursorProviderID                    = canonical.CursorProviderID
	CursorTargetID                      = "local:cursor"
	TuttiAgentProviderID                = canonical.TuttiAgentProviderID
	TuttiAgentTargetID                  = "local:tutti-agent"
	TuttiAgentMinVersion                = "0.0.12"
	TuttiAgentRecommendedVersion        = "0.0.12"
	TuttiAgentThroughTurnForkMinVersion = "0.0.11"
	NexightProviderID                   = canonical.NexightProviderID
	NexightTargetID                     = "local:nexight"
	OpenClawProviderID                  = canonical.OpenClawProviderID
	OpenClawTargetID                    = "local:openclaw"
)

const temporarilyUnsupportedReason = "provider_temporarily_unsupported"

func cursorDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: canonicalProviderIdentity(CursorProviderID),
		Runtime: RuntimeDescriptor{
			Kind: RuntimeKindStandardACP, Name: "cursor-acp", Command: []string{"cursor-agent", "acp"},
			AuthRequiredMessage: "Cursor ACP requires authentication; run `cursor-agent login` (or set CURSOR_API_KEY) on the host, then retry this session.",
			StandardACP: StandardACPRuntimeDescriptor{
				AdapterStrategy:    StandardACPAdapterStrategyCursor,
				PermissionModes:    []RuntimePermissionModeDescriptor{{InputID: "read-only", RuntimeID: "ask"}, {InputID: "agent", RuntimeID: "agent"}, {InputID: "full-access", RuntimeID: "agent"}, {InputID: "plan", RuntimeID: "plan"}, {InputID: "ask", RuntimeID: "ask"}},
				PlanModeRuntimeID:  "plan",
				ProjectCurrentMode: true,
			},
		},
		Status: StatusDescriptor{
			Kind: StatusKindGenericCLI, AuthOutputParserKind: AuthOutputParserKindCursor, AuthMarkerParserKind: AuthMarkerParserKindFileExists, AuthCommandRunnerKind: AuthCommandRunnerKindCursor, StaticSpecResolverKind: StaticSpecResolverKindCursor, BinaryNames: []string{"cursor-agent", "agent"}, AuthStatusCommand: []string{"status"}, AuthMarkerPaths: []string{"~/.cursor/cli-config.json"}, LoginArgs: []string{"login"},
			Install: InstallerDescriptor{
				Kind:            InstallerKindOfficialScript,
				DisplayCommand:  "curl https://cursor.com/install -fsS | bash",
				ScriptURL:       "https://cursor.com/install",
				ScriptShell:     "bash",
				WindowsFallback: InstallerWindowsFallbackPowerShell,
				// Cursor's official Windows script uses Invoke-WebRequest for the
				// archive download. On some Windows networks that cmdlet returns an
				// EOF while the script still exits 0, leaving no CLI behind. Keep the
				// official script's version/path logic, but use the inbox curl.exe
				// downloader with bounded retries for the archive transfer.
				WindowsPowerShellCommand: `$script = irm 'https://cursor.com/install?win32=true'; $script = $script.Replace('Invoke-WebRequest -Uri $fullUrl -OutFile $tempFile', 'curl.exe -fL --retry 3 --retry-delay 1 --retry-all-errors --output $tempFile $fullUrl; if ($LASTEXITCODE -ne 0) { throw "Cursor Agent download failed with exit code $LASTEXITCODE" }'); iex $script`,
			},
			Update: UpdateDescriptor{Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonOfficialScript},
		},
		ComposerProfile: ComposerProfileDescriptor{
			// Cursor exposes its account-scoped model catalog from ACP session/new,
			// so an empty composer needs a no-prompt hidden session before the first
			// visible conversation can choose a non-default model.
			ModelSelection: true, LiveModelDiscovery: LiveModelDiscoveryDescriptor{Kind: LiveModelDiscoveryKindRuntimeSession, HiddenProbe: true, AccountScoped: true}, Capabilities: []string{CapabilityImageInput, CapabilityModelImageInputRequired, CapabilityInterrupt, CapabilityPlanMode, CapabilityModelSwitch}, PermissionConfigurable: true, DefaultPermissionModeID: "agent",
			PermissionModes: []PermissionModeDescriptor{{ID: "read-only", Semantic: "ask-before-write"}, {ID: "agent", Semantic: "auto"}, {ID: "full-access", Semantic: "full-access"}}, ConfigOptionIDs: ComposerConfigOptionIDs{Model: "model"},
			SlashCommandPolicy: SlashCommandPolicyDescriptor{
				FallbackCommands:            []string{"plan"},
				CommandCatalogAuthoritative: true,
				CommandEffects: []SlashCommandEffectDescriptor{
					{Command: "plan", Effect: SlashCommandEffectTogglePlanMode},
				},
			},
			Behavior:                ComposerBehaviorDescriptor{CollapseModelOptionsToLatest: true, PreserveLiveModelCache: true},
			ModelCapabilityRuleKind: ModelCapabilityRuleKindCursorComposerImage,
			Skills:                  SkillDescriptor{Kind: SkillKindCursor, Invocation: SkillInvocationTextTrigger},
		},
		Target:  TargetDescriptor{ID: CursorTargetID, LaunchRefType: TargetLaunchRefTypeLocalCLI, Enabled: true, SortOrder: 30},
		Events:  EventsDescriptor{Enabled: true, Aliases: []string{"cursor-agent", "cursor_agent"}, TurnLifecycleProjection: TurnLifecycleProjectionExplicit},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 3, StatusProbePriority: 3, RuntimeProbeFallback: DesktopRuntimeProbeFallbackDirect, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 4},
	}
}

func tuttiAgentDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: canonicalProviderIdentity(TuttiAgentProviderID),
		Runtime: RuntimeDescriptor{
			Kind:                RuntimeKindCodexAppServer,
			Name:                "tutti-agent-app-server",
			Command:             []string{"tutti-agent", "app-server"},
			ClientInfoName:      "tutti_agent",
			AuthRequiredMessage: "Tutti Agent requires authentication. Sign in to Tutti on this device (or run `tutti-agent login`), then retry this session.",
			AppServerSkillRoots: AppServerSkillRootsStrategyTuttiStable,
			NativeSessionFork:   true,
			AppServerFork: AppServerForkDescriptor{
				UserAgentBrand:        "tutti-agent",
				ThroughTurnMinVersion: TuttiAgentThroughTurnForkMinVersion,
			},
			Endpoint: RuntimeEndpointDescriptor{
				ModelPlanProtocol:        ModelPlanProtocolOpenAI,
				ModelPlanEndpointAdapter: ModelPlanEndpointAdapterResponsesToChatGateway,
			},
		},
		Status: StatusDescriptor{
			Kind: StatusKindGenericCLI, AuthOutputParserKind: AuthOutputParserKindCodex, AuthMarkerParserKind: AuthMarkerParserKindTuttiToken, AuthCommandRunnerKind: AuthCommandRunnerKindGeneric, StaticSpecResolverKind: StaticSpecResolverKindManagedNode, MinVersion: TuttiAgentMinVersion, BinaryNames: []string{"tutti-agent"}, AdapterBinaryNames: []string{"tutti-agent"}, AuthStatusCommand: []string{"login", "status"}, AuthMarkerPaths: []string{"~/.tutti-agent/auth.json"}, LoginArgs: []string{"login"}, LoginActionKind: StatusActionKindDaemon,
			Install: InstallerDescriptor{Kind: InstallerKindManagedNPM, DisplayCommand: "npm install -g @tutti-os/tutti-agent@" + TuttiAgentRecommendedVersion + " --include=optional", PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", RecommendedVersion: TuttiAgentRecommendedVersion, IncludeOptional: true},
			Update:  UpdateDescriptor{Capability: UpdateCapabilitySupported, Source: UpdateSourceNPM, Strategy: UpdateStrategyManagedNPM, PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", IncludeOptional: true},
			AuthWatch: AuthWatchDescriptor{
				Sources: []AuthWatchSourceDescriptor{
					{
						DefaultRoot: "~/.tutti-agent",
						Paths:       []string{"auth.json"},
					},
				},
				ContentFingerprint: AuthWatchContentFingerprintFullFile,
			},
		},
		ComposerProfile: ComposerProfileDescriptor{
			ModelSelection: true, ModelCatalog: ModelCatalogKindTuttiCLI,
			Capabilities: []string{CapabilityImageInput, CapabilitySkills, CapabilityCompact, CapabilityTokenUsage, CapabilityPlanMode, CapabilityInterrupt, CapabilityActiveTurnGuidance, CapabilityModelSwitch, CapabilityModelPlanBinding}, PermissionConfigurable: true, DefaultPermissionModeID: "auto",
			PermissionModes: []PermissionModeDescriptor{{ID: "read-only", Semantic: "ask-before-write"}, {ID: "auto", Semantic: "auto"}, {ID: "full-access", Semantic: "full-access"}}, ConfigOptionIDs: ComposerConfigOptionIDs{Model: "model", Permission: "mode"},
			CapabilityCatalog: CapabilityCatalogDescriptor{Kind: CapabilityCatalogKindAppServerSkills},
			SlashCommandPolicy: SlashCommandPolicyDescriptor{
				FallbackCommands: []string{"compact", "plan", "goal", "review"},
				CommandEffects: []SlashCommandEffectDescriptor{
					{Command: "compact", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "plan", Effect: SlashCommandEffectTogglePlanMode},
					{Command: "goal", Effect: SlashCommandEffectActivateGoalMode},
					{Command: "review", Effect: SlashCommandEffectShowReviewPicker},
				},
			},
		},
		Target:  TargetDescriptor{ID: TuttiAgentTargetID, LaunchRefType: TargetLaunchRefTypeLocalCLI, Enabled: true, SortOrder: 5},
		Events:  EventsDescriptor{Enabled: true, Aliases: []string{"tutti_agent"}, TurnLifecycleProjection: TurnLifecycleProjectionExplicit},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 4, StatusProbePriority: 4, VisibilityGate: DesktopVisibilityGateTuttiAgent, CommandNetworkAccess: true, InstallBootstrap: true, RefreshOnAccountChange: true, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 1},
	}
}

func nexightDescriptor() ProviderDescriptor {
	descriptor := unsupportedACPDescriptor(NexightProviderID, NexightTargetID, RuntimeDescriptor{
		Kind: RuntimeKindStandardACP, Name: "nexight-acp", Command: []string{"nexight-acp"}, AuthRequiredMessage: "Nexight ACP requires authentication in the runtime VM. Sync the Nexight host credentials, then retry this session.",
		StandardACP: StandardACPRuntimeDescriptor{AdapterStrategy: StandardACPAdapterStrategyNexight, PermissionModes: []RuntimePermissionModeDescriptor{{InputID: "read-only", RuntimeID: "read-only"}, {InputID: "auto", RuntimeID: "auto"}, {InputID: "full-access", RuntimeID: "full-access"}}, DeriveImageInputFromPrompt: true, DeriveCapabilitiesFromCommands: []string{CapabilityCompact}},
	}, StatusDescriptor{Kind: StatusKindGenericCLI, BinaryNames: []string{"nexight"}, AdapterBinaryNames: []string{"nexight-acp"}, AuthMarkerPaths: []string{"~/.nexight/auth.json", "~/.tutti/nexight/auth.json"}, LoginArgs: []string{"login"}}, ComposerProfileDescriptor{
		Capabilities: []string{CapabilityInterrupt}, PermissionConfigurable: true, DefaultPermissionModeID: "auto", PermissionModes: []PermissionModeDescriptor{{ID: "read-only", Semantic: "ask-before-write"}, {ID: "auto", Semantic: "auto"}, {ID: "full-access", Semantic: "full-access"}},
	}, 60)
	descriptor.Sidecar.SkillRoot = ".nexight/skills"
	return descriptor
}

func openClawDescriptor() ProviderDescriptor {
	descriptor := unsupportedACPDescriptor(OpenClawProviderID, OpenClawTargetID, RuntimeDescriptor{
		Kind: RuntimeKindStandardACP, Name: "openclaw-acp", Command: []string{"openclaw", "acp", "-v"}, AuthRequiredMessage: "OpenClaw ACP requires authentication in the runtime VM; ensure OpenClaw host credentials are synced before starting Agent GUI",
		StandardACP: StandardACPRuntimeDescriptor{AdapterStrategy: StandardACPAdapterStrategyOpenClaw, DeriveImageInputFromPrompt: true, DeriveCapabilitiesFromCommands: []string{CapabilityCompact}},
	}, StatusDescriptor{
		Kind: StatusKindGenericCLI, BinaryNames: []string{"openclaw"}, AuthMarkerPaths: []string{"~/.openclaw/auth.json", "~/.config/openclaw/auth.json"}, LoginArgs: []string{"login"},
		Install: InstallerDescriptor{Kind: InstallerKindShellCommand, DisplayCommand: "npm install -g openclaw", ShellCommand: "npm install -g openclaw"},
		Update:  UpdateDescriptor{Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonUnmanagedSource},
	}, ComposerProfileDescriptor{Capabilities: []string{CapabilityInterrupt}}, 80)
	descriptor.Events.Aliases = []string{"open-claw", "open_claw"}
	descriptor.Sidecar.SkillRoot = ".openclaw/skills"
	descriptor.Desktop.Managed = true
	descriptor.Desktop.ManagedOrder = 7
	descriptor.Desktop.StatusProbePriority = 7
	descriptor.Desktop.UnavailableDockOrderOffset = 200
	return descriptor
}

func unsupportedACPDescriptor(providerID string, targetID string, runtime RuntimeDescriptor, status StatusDescriptor, composer ComposerProfileDescriptor, sortOrder int) ProviderDescriptor {
	status.SupportStatus = "unsupported"
	status.DisabledReasonCode = temporarilyUnsupportedReason
	status.AuthMarkerParserKind = AuthMarkerParserKindFileExists
	status.AuthCommandRunnerKind = AuthCommandRunnerKindGeneric
	status.StaticSpecResolverKind = StaticSpecResolverKindGeneric
	if status.Update.Capability == "" {
		status.Update = UpdateDescriptor{Capability: UpdateCapabilityUnsupported, UnsupportedReason: UpdateUnsupportedReasonProvider}
	}
	return ProviderDescriptor{
		Identity: canonicalProviderIdentity(providerID), Runtime: runtime, Status: status, ComposerProfile: composer,
		Target:  TargetDescriptor{ID: targetID, LaunchRefType: TargetLaunchRefTypeLocalCLI, Enabled: false, SortOrder: sortOrder},
		Events:  EventsDescriptor{Enabled: true, TurnLifecycleProjection: TurnLifecycleProjectionExplicit},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
	}
}
