package providerregistry

// This file owns the descriptors shared by the remaining provider families.

const (
	CursorProviderID     = "cursor"
	CursorTargetID       = "local:cursor"
	TuttiAgentProviderID = "tutti-agent"
	TuttiAgentTargetID   = "local:tutti-agent"
	NexightProviderID    = "nexight"
	NexightTargetID      = "local:nexight"
	HermesProviderID     = "hermes"
	HermesTargetID       = "local:hermes"
	OpenClawProviderID   = "openclaw"
	OpenClawTargetID     = "local:openclaw"
)

const temporarilyUnsupportedReason = "provider_temporarily_unsupported"

func cursorDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: IdentityDescriptor{ID: CursorProviderID, DisplayName: "Cursor", IconKey: "cursor", LocaleKey: "agentHost.agentGui.conversationFilterCursor", Aliases: []string{"cursor-agent", "cursor agent", "cursor-cli"}},
		Runtime: RuntimeDescriptor{
			Kind: RuntimeKindStandardACP, Name: "cursor-acp", Command: []string{"cursor-agent", "acp"},
			AuthRequiredMessage: "Cursor ACP requires authentication; run `cursor-agent login` (or set CURSOR_API_KEY) on the host, then retry this session.",
			StandardACP: StandardACPRuntimeDescriptor{
				AdapterStrategy:    StandardACPAdapterStrategyCursor,
				PermissionModes:    []RuntimePermissionModeDescriptor{{InputID: "read-only", RuntimeID: "plan"}, {InputID: "agent", RuntimeID: "agent"}, {InputID: "full-access", RuntimeID: "agent"}, {InputID: "plan", RuntimeID: "plan"}, {InputID: "ask", RuntimeID: "ask"}},
				PlanModeRuntimeID:  "plan",
				ProjectCurrentMode: true,
			},
		},
		Status: StatusDescriptor{
			Kind: StatusKindGenericCLI, AuthOutputParserKind: AuthOutputParserKindCursor, AuthMarkerParserKind: AuthMarkerParserKindFileExists, AuthCommandRunnerKind: AuthCommandRunnerKindCursor, StaticSpecResolverKind: StaticSpecResolverKindCursor, BinaryNames: []string{"cursor-agent", "agent"}, AuthStatusCommand: []string{"status"}, AuthMarkerPaths: []string{"~/.cursor/cli-config.json"}, LoginArgs: []string{"login"},
			Install: InstallerDescriptor{Kind: InstallerKindOfficialScript, DisplayCommand: "curl https://cursor.com/install -fsS | bash", ScriptURL: "https://cursor.com/install", ScriptShell: "bash"},
		},
		ComposerProfile: ComposerProfileDescriptor{
			ModelSelection: true, LiveModelDiscovery: LiveModelDiscoveryDescriptor{Kind: LiveModelDiscoveryKindRuntimeSession}, Capabilities: []string{CapabilityImageInput, CapabilityModelImageInputRequired, CapabilityInterrupt, CapabilityPlanMode}, PermissionConfigurable: true, DefaultPermissionModeID: "agent",
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
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 3, StatusProbePriority: 3, VisibilityGate: DesktopVisibilityGateCursorPreview, RuntimeProbeFallback: DesktopRuntimeProbeFallbackDirect, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 3},
	}
}

func tuttiAgentDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: IdentityDescriptor{ID: TuttiAgentProviderID, DisplayName: "Tutti Agent", IconKey: "tutti", LocaleKey: "agentHost.agentGui.conversationFilterTutti", Aliases: []string{"tutti agent"}},
		Runtime:  RuntimeDescriptor{Kind: RuntimeKindCodexAppServer, Name: "tutti-agent-app-server", Command: []string{"tutti-agent", "app-server"}, ClientInfoName: "tutti_agent", AuthRequiredMessage: "Tutti Agent requires authentication. Sign in to Tutti on this device (or run `tutti-agent login`), then retry this session."},
		Status: StatusDescriptor{
			Kind: StatusKindGenericCLI, AuthOutputParserKind: AuthOutputParserKindCodex, AuthMarkerParserKind: AuthMarkerParserKindTuttiToken, AuthCommandRunnerKind: AuthCommandRunnerKindGeneric, StaticSpecResolverKind: StaticSpecResolverKindGeneric, BinaryNames: []string{"tutti-agent"}, AdapterBinaryNames: []string{"tutti-agent"}, AuthStatusCommand: []string{"login", "status"}, AuthMarkerPaths: []string{"~/.tutti-agent/auth.json"}, LoginArgs: []string{"login"}, LoginActionKind: StatusActionKindDaemon,
			Install: InstallerDescriptor{Kind: InstallerKindManagedNPM, DisplayCommand: "npm install -g @tutti-os/tutti-agent --include=optional", PackageName: "@tutti-os/tutti-agent", BinaryName: "tutti-agent", IncludeOptional: true},
		},
		ComposerProfile: ComposerProfileDescriptor{
			ModelSelection: true, ModelCatalog: ModelCatalogKindTuttiCLI, ReasoningEffort: true, ReasoningEffortOptions: ReasoningEffortOptionsModelCatalog, DefaultReasoningEffort: "high", Speed: true,
			Capabilities: []string{CapabilityImageInput, CapabilitySkills, CapabilityCompact, CapabilityTokenUsage, CapabilityRateLimits, CapabilityPlanMode, CapabilityInterrupt}, PermissionConfigurable: true, DefaultPermissionModeID: "auto",
			PermissionModes: []PermissionModeDescriptor{{ID: "read-only", Semantic: "ask-before-write"}, {ID: "auto", Semantic: "auto"}, {ID: "full-access", Semantic: "full-access"}}, ConfigOptionIDs: ComposerConfigOptionIDs{Model: "model", Reasoning: "reasoning_effort", Speed: "service_tier", Permission: "mode"},
		},
		Target:  TargetDescriptor{ID: TuttiAgentTargetID, LaunchRefType: TargetLaunchRefTypeLocalCLI, Enabled: false, SortOrder: 40},
		Events:  EventsDescriptor{Enabled: true, Aliases: []string{"tutti_agent"}, TurnLifecycleProjection: TurnLifecycleProjectionExplicit},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 4, StatusProbePriority: 4, VisibilityGate: DesktopVisibilityGateTuttiAgent, InstallBootstrap: true, RefreshOnAccountChange: true},
	}
}

func nexightDescriptor() ProviderDescriptor {
	descriptor := unsupportedACPDescriptor(NexightProviderID, NexightTargetID, "Nexight", "tutti", "agentHost.agentGui.conversationFilterNexight", []string{"tutti"}, RuntimeDescriptor{
		Kind: RuntimeKindStandardACP, Name: "nexight-acp", Command: []string{"nexight-acp"}, AuthRequiredMessage: "Nexight ACP requires authentication in the runtime VM. Sync the Nexight host credentials, then retry this session.",
		StandardACP: StandardACPRuntimeDescriptor{AdapterStrategy: StandardACPAdapterStrategyNexight, PermissionModes: []RuntimePermissionModeDescriptor{{InputID: "read-only", RuntimeID: "read-only"}, {InputID: "auto", RuntimeID: "auto"}, {InputID: "full-access", RuntimeID: "full-access"}}, DeriveImageInputFromPrompt: true, DeriveCapabilitiesFromCommands: []string{CapabilityCompact}},
	}, StatusDescriptor{Kind: StatusKindGenericCLI, BinaryNames: []string{"nexight"}, AdapterBinaryNames: []string{"nexight-acp"}, AuthMarkerPaths: []string{"~/.nexight/auth.json", "~/.tutti/nexight/auth.json"}, LoginArgs: []string{"login"}}, ComposerProfileDescriptor{
		Capabilities: []string{CapabilityInterrupt}, PermissionConfigurable: true, DefaultPermissionModeID: "auto", PermissionModes: []PermissionModeDescriptor{{ID: "read-only", Semantic: "ask-before-write"}, {ID: "auto", Semantic: "auto"}, {ID: "full-access", Semantic: "full-access"}},
	}, 60)
	descriptor.Sidecar.SkillRoot = ".nexight/skills"
	return descriptor
}

func hermesDescriptor() ProviderDescriptor {
	descriptor := unsupportedACPDescriptor(HermesProviderID, HermesTargetID, "Hermes Agent", "hermes", "agentHost.agentGui.conversationFilterHermes", []string{"hermes-agent", "hermes agent"}, RuntimeDescriptor{
		Kind: RuntimeKindStandardACP, Name: "hermes-acp", Command: []string{"hermes", "acp"}, AuthRequiredMessage: "Hermes ACP requires authentication in the runtime VM; ensure Hermes host credentials are synced before starting Agent GUI",
		StandardACP: StandardACPRuntimeDescriptor{AdapterStrategy: StandardACPAdapterStrategyGeneric, PermissionModes: []RuntimePermissionModeDescriptor{{InputID: "yolo", RuntimeID: "yolo"}}, DefaultPermissionModeRuntimeID: "yolo", StartupDiagnostics: true, DeriveImageInputFromPrompt: true, DeriveCapabilitiesFromCommands: []string{CapabilityCompact}},
	}, StatusDescriptor{Kind: StatusKindGenericCLI, BinaryNames: []string{"hermes"}, AuthMarkerPaths: []string{"~/.hermes/auth.json", "~/.config/hermes/auth.json"}, LoginArgs: []string{"login"}}, ComposerProfileDescriptor{
		Capabilities: []string{CapabilityInterrupt}, DefaultPermissionModeID: "yolo", PermissionModes: []PermissionModeDescriptor{{ID: "yolo", Semantic: "unconfigurable"}},
	}, 70)
	descriptor.Events.Aliases = []string{"hermes-agent", "hermes_agent"}
	descriptor.Sidecar.SkillRoot = ".agent_context/skills"
	descriptor.Desktop.Managed = true
	descriptor.Desktop.ManagedOrder = 6
	descriptor.Desktop.StatusProbePriority = 6
	return descriptor
}

func openClawDescriptor() ProviderDescriptor {
	descriptor := unsupportedACPDescriptor(OpenClawProviderID, OpenClawTargetID, "OpenClaw", "openclaw", "agentHost.agentGui.conversationFilterOpenClaw", []string{"open-claw"}, RuntimeDescriptor{
		Kind: RuntimeKindStandardACP, Name: "openclaw-acp", Command: []string{"openclaw", "acp", "-v"}, AuthRequiredMessage: "OpenClaw ACP requires authentication in the runtime VM; ensure OpenClaw host credentials are synced before starting Agent GUI",
		StandardACP: StandardACPRuntimeDescriptor{AdapterStrategy: StandardACPAdapterStrategyOpenClaw, DeriveImageInputFromPrompt: true, DeriveCapabilitiesFromCommands: []string{CapabilityCompact}},
	}, StatusDescriptor{
		Kind: StatusKindGenericCLI, BinaryNames: []string{"openclaw"}, AuthMarkerPaths: []string{"~/.openclaw/auth.json", "~/.config/openclaw/auth.json"}, LoginArgs: []string{"login"},
		Install: InstallerDescriptor{Kind: InstallerKindShellCommand, DisplayCommand: "npm install -g openclaw", ShellCommand: "npm install -g openclaw"},
	}, ComposerProfileDescriptor{Capabilities: []string{CapabilityInterrupt}}, 80)
	descriptor.Events.Aliases = []string{"open-claw", "open_claw"}
	descriptor.Sidecar.SkillRoot = ".openclaw/skills"
	descriptor.Desktop.Managed = true
	descriptor.Desktop.ManagedOrder = 7
	descriptor.Desktop.StatusProbePriority = 7
	descriptor.Desktop.UnavailableDockOrderOffset = 200
	return descriptor
}

func unsupportedACPDescriptor(providerID string, targetID string, displayName string, iconKey string, localeKey string, aliases []string, runtime RuntimeDescriptor, status StatusDescriptor, composer ComposerProfileDescriptor, sortOrder int) ProviderDescriptor {
	status.SupportStatus = "unsupported"
	status.DisabledReasonCode = temporarilyUnsupportedReason
	status.AuthMarkerParserKind = AuthMarkerParserKindFileExists
	status.AuthCommandRunnerKind = AuthCommandRunnerKindGeneric
	status.StaticSpecResolverKind = StaticSpecResolverKindGeneric
	return ProviderDescriptor{
		Identity: IdentityDescriptor{ID: providerID, DisplayName: displayName, IconKey: iconKey, LocaleKey: localeKey, Aliases: aliases}, Runtime: runtime, Status: status, ComposerProfile: composer,
		Target:  TargetDescriptor{ID: targetID, LaunchRefType: TargetLaunchRefTypeLocalCLI, Enabled: false, SortOrder: sortOrder},
		Events:  EventsDescriptor{Enabled: true, TurnLifecycleProjection: TurnLifecycleProjectionExplicit},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
	}
}
