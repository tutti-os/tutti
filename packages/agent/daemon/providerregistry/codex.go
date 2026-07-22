package providerregistry

import canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"

const (
	CodexProviderID = canonical.CodexProviderID
	CodexTargetID   = "local:codex"
	CodexMinVersion = "0.126.0"
)

func codexDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: canonicalProviderIdentity(CodexProviderID),
		Runtime: RuntimeDescriptor{
			Kind:                RuntimeKindCodexAppServer,
			Name:                "codex-app-server",
			Command:             []string{"codex", "app-server"},
			ClientInfoName:      "codex_cli_rs",
			AuthRequiredMessage: "Codex requires authentication. Run `codex login` on the host (or sync Codex credentials), then retry this session.",
			Endpoint: RuntimeEndpointDescriptor{
				BaseURLEnvVars: []string{
					"OPENAI_BASE_URL",
					"OPENAI_API_BASE_URL",
					"OPENAI_API_BASE",
				},
				ConfigKind:        EndpointConfigKindCodexCLI,
				ModelPlanProtocol: ModelPlanProtocolOpenAI,
			},
		},
		Status: StatusDescriptor{
			Kind:                   StatusKindCodexCLI,
			AuthOutputParserKind:   AuthOutputParserKindCodex,
			AuthMarkerParserKind:   AuthMarkerParserKindFileExists,
			AuthCommandRunnerKind:  AuthCommandRunnerKindGeneric,
			StaticSpecResolverKind: StaticSpecResolverKindManagedNode,
			MinVersion:             CodexMinVersion,
			BinaryNames:            []string{"codex"},
			AuthStatusCommand:      []string{"login", "-c", `service_tier="fast"`, "status"},
			AuthMarkerPaths:        []string{"~/.codex/auth.json"},
			APIEndpoints: []string{
				"https://chatgpt.com/backend-api/codex",
				"https://api.openai.com/v1",
			},
			CustomConfigEnvVars: []string{
				"OPENAI_API_KEY",
				"OPENAI_BASE_URL",
				"OPENAI_API_BASE_URL",
				"OPENAI_API_BASE",
			},
			CredentialEnvVars:  []string{"OPENAI_API_KEY"},
			NPMRegistryPackage: "@openai/codex",
			Install: InstallerDescriptor{
				Kind:            InstallerKindCodexCLILatest,
				DisplayCommand:  "npm install -g @openai/codex --include=optional",
				PackageName:     "@openai/codex",
				BinaryName:      "codex",
				IncludeOptional: true,
			},
			Update: UpdateDescriptor{
				Capability:      UpdateCapabilitySupported,
				Source:          UpdateSourceNPM,
				Strategy:        UpdateStrategyManagedNPM,
				PackageName:     "@openai/codex",
				BinaryName:      "codex",
				IncludeOptional: true,
			},
			LoginArgs: []string{"login", "-c", `service_tier="fast"`},
			AuthWatch: AuthWatchDescriptor{
				Sources: []AuthWatchSourceDescriptor{
					{
						RootCandidates: []AuthWatchRootCandidateDescriptor{{EnvVar: "CODEX_HOME"}},
						DefaultRoot:    "~/.codex",
						Paths:          []string{"auth.json", "config.toml"},
					},
				},
			},
		},
		ComposerProfile: ComposerProfileDescriptor{
			ModelSelection:          true,
			ModelCatalog:            ModelCatalogKindCodexCLI,
			ReasoningEffort:         true,
			ReasoningEffortOptions:  ReasoningEffortOptionsModelCatalog,
			DefaultReasoningEffort:  "high",
			ConfiguredModelOverride: ConfiguredModelOverrideCodexCustomProvider,
			Speed:                   true,
			SpeedValues:             []string{"standard", "fast"},
			DefaultSpeed:            "standard",
			Capabilities: []string{
				CapabilityImageInput,
				CapabilitySkills,
				CapabilityCompact,
				CapabilityTokenUsage,
				CapabilityRateLimits,
				CapabilityPlanMode,
				CapabilityInterrupt,
				CapabilityActiveTurnGuidance,
				CapabilityGoalPause,
				CapabilityModelSwitch,
				CapabilityModelPlanBinding,
				CapabilityPlanImplementation,
				CapabilityPermissionModeChangeDuringTurn,
				CapabilityPermissionModeChangeDeferred,
			},
			PermissionConfigurable:  true,
			DefaultPermissionModeID: "auto",
			PermissionModes: []PermissionModeDescriptor{
				{ID: "read-only", Semantic: "ask-before-write"},
				{ID: "auto", Semantic: "auto"},
				{ID: "full-access", Semantic: "full-access"},
			},
			ConfigOptionIDs: ComposerConfigOptionIDs{
				Model:      "model",
				Reasoning:  "reasoning_effort",
				Speed:      "service_tier",
				Permission: "mode",
			},
			Skills: SkillDescriptor{
				Kind:       SkillKindCodex,
				Invocation: SkillInvocationPromptItem,
			},
			CapabilityCatalog: CapabilityCatalogDescriptor{
				Kind: CapabilityCatalogKindCodexAppServer,
			},
			SlashCommandPolicy: SlashCommandPolicyDescriptor{
				FallbackCommands: []string{"compact", "status", "fast", "goal", "review"},
				CommandEffects: []SlashCommandEffectDescriptor{
					{Command: "init", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "compact", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "review", Effect: SlashCommandEffectShowReviewPicker},
					{Command: "goal", Effect: SlashCommandEffectActivateGoalMode},
					{Command: "plan", Effect: SlashCommandEffectTogglePlanMode},
					{Command: "status", Effect: SlashCommandEffectShowStatus},
					{Command: "fast", Effect: SlashCommandEffectToggleSpeed},
				},
			},
			PlanDecisionStrategy: PlanDecisionStrategyImplementPrompt,
		},
		Target: TargetDescriptor{
			ID:            CodexTargetID,
			LaunchRefType: TargetLaunchRefTypeLocalCLI,
			Enabled:       true,
			SortOrder:     10,
		},
		Events: EventsDescriptor{
			Enabled:                 true,
			TurnLifecycleProjection: TurnLifecycleProjectionExplicit,
		},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentCodexSandbox},
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 2, StatusProbePriority: 1, UsageProbeKind: DesktopUsageProbeCodex, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 1},
		ExternalImport: ExternalImportDescriptor{
			Enabled:                  true,
			RootEnvVar:               "CODEX_HOME",
			DefaultRoot:              "~/.codex",
			ScanDirectories:          []string{"sessions", "archived_sessions"},
			ParserKind:               ExternalImportParserKindCodexJSONL,
			UserTextCleanerKind:      ExternalImportUserTextCleanerKindCodex,
			TitleCatalogKind:         ExternalImportTitleCatalogKindCodexSQLite,
			NoProjectHomeRelativeDir: "Documents/Codex",
		},
	}
}
